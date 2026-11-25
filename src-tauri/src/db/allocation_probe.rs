//! Test-only per-thread Rust heap allocation measurement.
//!
//! This probe observes net live allocations routed through Rust's global
//! allocator on the synchronous thread that enables it. It deliberately does
//! not measure mmap resident pages, SQLite's native allocations, or work on
//! other threads. Freeing allocations created before a measured scope can
//! reduce its accounting, so callers keep large fixture allocations outside
//! the scope and alive until measurement ends.

use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
};

struct TrackingAllocator;

#[global_allocator]
static ALLOCATOR: TrackingAllocator = TrackingAllocator;

std::thread_local! {
    static ENABLED: Cell<bool> = const { Cell::new(false) };
    static CURRENT: Cell<usize> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
}

fn record_allocated(bytes: usize) {
    let _ = ENABLED.try_with(|enabled| {
        if !enabled.get() {
            return;
        }
        let _ = CURRENT.try_with(|current| {
            let next = current.get().saturating_add(bytes);
            current.set(next);
            let _ = PEAK.try_with(|peak| peak.set(peak.get().max(next)));
        });
    });
}

fn record_deallocated(bytes: usize) {
    let _ = ENABLED.try_with(|enabled| {
        if enabled.get() {
            let _ = CURRENT.try_with(|current| {
                current.set(current.get().saturating_sub(bytes));
            });
        }
    });
}

unsafe impl GlobalAlloc for TrackingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: forwarding the allocator contract unchanged to System.
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            record_allocated(layout.size());
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: forwarding the allocator contract unchanged to System.
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            record_allocated(layout.size());
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        record_deallocated(layout.size());
        // SAFETY: pointer and layout are forwarded unchanged to System.
        unsafe { System.dealloc(pointer, layout) };
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: pointer, old layout, and new size are forwarded unchanged.
        let replacement = unsafe { System.realloc(pointer, layout, new_size) };
        if !replacement.is_null() {
            if new_size >= layout.size() {
                record_allocated(new_size - layout.size());
            } else {
                record_deallocated(layout.size() - new_size);
            }
        }
        replacement
    }
}

struct ResetOnDrop;

impl Drop for ResetOnDrop {
    fn drop(&mut self) {
        let _ = ENABLED.try_with(|enabled| enabled.set(false));
        let _ = CURRENT.try_with(|current| current.set(0));
        let _ = PEAK.try_with(|peak| peak.set(0));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AllocationMeasurement {
    pub peak: usize,
    pub live_at_end: usize,
}

impl AllocationMeasurement {
    pub(crate) fn working_memory(self) -> usize {
        self.peak.saturating_sub(self.live_at_end)
    }
}

pub(crate) fn measure_with_live<R>(operation: impl FnOnce() -> R) -> (R, AllocationMeasurement) {
    ENABLED.with(|enabled| {
        assert!(!enabled.replace(true), "allocation probe cannot be nested");
    });
    CURRENT.with(|current| current.set(0));
    PEAK.with(|peak| peak.set(0));
    let reset = ResetOnDrop;
    let result = operation();
    ENABLED.with(|enabled| enabled.set(false));
    let measurement = AllocationMeasurement {
        peak: PEAK.with(Cell::get),
        live_at_end: CURRENT.with(Cell::get),
    };
    drop(reset);
    (result, measurement)
}

pub(crate) fn measure<R>(operation: impl FnOnce() -> R) -> (R, usize) {
    let (result, measurement) = measure_with_live(operation);
    (result, measurement.peak)
}

pub(crate) fn assert_detects_owned_collection(bytes: usize, threshold: usize) -> usize {
    let (owned, peak) = measure(|| std::hint::black_box(vec![0_u8; bytes]));
    assert_eq!(owned.len(), bytes);
    assert!(
        peak > threshold,
        "probe sanity check peak {peak} did not exceed threshold {threshold}"
    );
    peak
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measure_with_live_separates_retained_bytes_from_working_memory() {
        const RETAINED: usize = 256 * 1024;
        const TRANSIENT: usize = 64 * 1024;

        let (kept, measurement) = measure_with_live(|| {
            let retained = std::hint::black_box(vec![1_u8; RETAINED]);
            let transient = std::hint::black_box(vec![2_u8; TRANSIENT]);
            drop(transient);
            retained
        });
        assert_eq!(kept.len(), RETAINED);
        assert!(
            measurement.live_at_end >= RETAINED,
            "live_at_end {} should include retained {RETAINED}",
            measurement.live_at_end
        );
        assert!(
            measurement.live_at_end < RETAINED + TRANSIENT,
            "live_at_end {} should exclude dropped transient {TRANSIENT}",
            measurement.live_at_end
        );
        assert!(
            measurement.peak >= RETAINED + TRANSIENT,
            "peak {} should include retained + transient",
            measurement.peak
        );
        assert!(
            measurement.working_memory() >= TRANSIENT,
            "working_memory {} should include transient {TRANSIENT}",
            measurement.working_memory()
        );
        assert!(
            measurement.working_memory() < RETAINED,
            "working_memory {} should exclude retained {RETAINED} (peak {})",
            measurement.working_memory(),
            measurement.peak
        );
    }
}
