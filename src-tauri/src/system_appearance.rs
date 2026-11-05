//! Keeps GTK's dark-theme preference in step with the desktop's light/dark setting.
//!
//! WebKitGTK derives `prefers-color-scheme` from `GtkSettings:gtk-application-prefer-dark-theme`
//! and follows that property live, which is what the renderer's "auto" colour scheme listens to.
//! Under Wayland, GTK 3 reads the property from `settings.ini` once at startup, so a desktop
//! switch (KDE Plasma measured 2026-11-05) never reached a running window. The desktop announces
//! the switch through the XDG Settings portal as `org.freedesktop.appearance color-scheme`; this
//! module reads that value at startup and on every `SettingChanged` signal and writes it into
//! GtkSettings.
//!
//! Ownership: the subscription lives on the GTK main thread for the whole process and ends with
//! the session bus connection at process exit. An absent or failing portal only logs; the
//! window then keeps GTK's own startup value, which is the behaviour before this module existed.

use std::rc::Rc;

use gtk::gio;
use gtk::glib;
use gtk::prelude::*;

const PORTAL_BUS_NAME: &str = "org.freedesktop.portal.Desktop";
const PORTAL_OBJECT_PATH: &str = "/org/freedesktop/portal/desktop";
const SETTINGS_INTERFACE: &str = "org.freedesktop.portal.Settings";
const APPEARANCE_NAMESPACE: &str = "org.freedesktop.appearance";
const COLOR_SCHEME_KEY: &str = "color-scheme";
const READ_ONE_METHOD: &str = "ReadOne";
const LEGACY_READ_METHOD: &str = "Read";
const READ_TIMEOUT_MS: i32 = 2_000;
/// Variant layers examined before giving up: the legacy `Read` reply is the deepest shape,
/// `(v)` → `v` → `u`, so three unwraps reach the scalar; one spare layer tolerates a
/// redundant box without accepting arbitrarily nested input.
const MAX_VARIANT_DEPTH: usize = 4;

thread_local! {
    // Keeps the connection and its subscription alive on the main thread for the process lifetime.
    static SUBSCRIPTION: std::cell::RefCell<Option<(gio::DBusConnection, gio::SignalSubscriptionId)>> =
        const { std::cell::RefCell::new(None) };
}

/// The one GTK property this module drives, behind a seam so the follower is testable without
/// a display.
trait PreferDarkSetting {
    fn prefer_dark(&self) -> bool;
    fn set_prefer_dark(&self, prefer_dark: bool);
}

impl PreferDarkSetting for gtk::Settings {
    fn prefer_dark(&self) -> bool {
        self.is_gtk_application_prefer_dark_theme()
    }

    fn set_prefer_dark(&self, prefer_dark: bool) {
        self.set_gtk_application_prefer_dark_theme(prefer_dark);
    }
}

struct Follower<S> {
    setting: S,
    /// GTK's value before this module wrote anything: what the user configured for GTK.
    startup_prefer_dark: bool,
}

impl<S: PreferDarkSetting> Follower<S> {
    fn new(setting: S) -> Self {
        let startup_prefer_dark = setting.prefer_dark();
        Self {
            setting,
            startup_prefer_dark,
        }
    }

    /// Maps the portal's `color-scheme` value to GTK's dark preference. `0` ("no preference")
    /// is GNOME's light setting, so it withdraws an earlier dark override by restoring GTK's
    /// startup value; any unknown value is ignored.
    fn prefer_dark_for(&self, color_scheme: u32) -> Option<bool> {
        match color_scheme {
            0 => Some(self.startup_prefer_dark),
            1 => Some(true),
            2 => Some(false),
            _ => None,
        }
    }

    fn apply(&self, color_scheme: u32) {
        let Some(prefer_dark) = self.prefer_dark_for(color_scheme) else {
            return;
        };
        if self.setting.prefer_dark() != prefer_dark {
            log::info!("desktop colour scheme changed, prefer dark theme: {prefer_dark}");
            self.setting.set_prefer_dark(prefer_dark);
        }
    }

    fn on_setting_changed(&self, parameters: &glib::Variant) {
        if let Some(color_scheme) = color_scheme_from_setting_changed(parameters) {
            self.apply(color_scheme);
        }
    }

    /// Handles a `ReadOne`/`Read` reply and says whether the legacy method is still worth trying.
    fn on_read_reply(
        &self,
        method: &str,
        reply: Result<glib::Variant, glib::Error>,
    ) -> Option<&'static str> {
        match reply {
            Ok(reply) => {
                if let Some(color_scheme) = color_scheme_from_variant(&reply) {
                    self.apply(color_scheme);
                }
                None
            }
            // Portal interface version 1 has only `Read`.
            Err(_) if method == READ_ONE_METHOD => Some(LEGACY_READ_METHOD),
            Err(error) => {
                log::info!("desktop colour scheme could not be read: {error}");
                None
            }
        }
    }
}

/// Unwraps the `color-scheme` value from a portal reply or signal value. `ReadOne` replies
/// `(v)` holding `u`; the older `Read` replies `(v)` holding `v` holding `u`; a signal value is
/// `v` holding `u`. Any other shape yields `None`.
fn color_scheme_from_variant(variant: &glib::Variant) -> Option<u32> {
    let mut current = variant.clone();
    for _ in 0..MAX_VARIANT_DEPTH {
        if let Some(value) = current.get::<u32>() {
            return Some(value);
        }
        current = if current.is_container() && current.n_children() == 1 {
            current.child_value(0)
        } else {
            return None;
        };
    }
    None
}

/// Extracts the colour scheme from `SettingChanged`'s `(ssv)` parameters when the signal is
/// about the appearance namespace's `color-scheme` key.
fn color_scheme_from_setting_changed(parameters: &glib::Variant) -> Option<u32> {
    let (namespace, key, value) = parameters.get::<(String, String, glib::Variant)>()?;
    (namespace == APPEARANCE_NAMESPACE && key == COLOR_SCHEME_KEY)
        .then(|| color_scheme_from_variant(&value))
        .flatten()
}

fn read_color_scheme(
    connection: &gio::DBusConnection,
    follower: Rc<Follower<gtk::Settings>>,
    method: &'static str,
) {
    let retry_connection = connection.clone();
    connection.call(
        Some(PORTAL_BUS_NAME),
        PORTAL_OBJECT_PATH,
        SETTINGS_INTERFACE,
        method,
        Some(&(APPEARANCE_NAMESPACE, COLOR_SCHEME_KEY).to_variant()),
        None,
        gio::DBusCallFlags::NONE,
        READ_TIMEOUT_MS,
        None::<&gio::Cancellable>,
        move |reply| {
            if let Some(retry) = follower.on_read_reply(method, reply) {
                read_color_scheme(&retry_connection, follower, retry);
            }
        },
    );
}

/// Starts following the desktop colour scheme. Must run on the GTK main thread (Tauri's
/// `setup`), whose main context dispatches the D-Bus callbacks.
pub fn follow_desktop_color_scheme() {
    let Some(settings) = gtk::Settings::default() else {
        log::warn!("GTK settings are unavailable; the desktop colour scheme is not followed");
        return;
    };
    let follower = Rc::new(Follower::new(settings));
    gio::bus_get(
        gio::BusType::Session,
        None::<&gio::Cancellable>,
        move |connection| {
            let connection = match connection {
                Ok(connection) => connection,
                Err(error) => {
                    log::info!(
                        "session bus unavailable, desktop colour scheme not followed: {error}"
                    );
                    return;
                }
            };
            // Subscribe before reading: the reply and later signals come from the same portal
            // connection in order, so whichever arrives last carries the current value.
            let subscription = connection.signal_subscribe(
                Some(PORTAL_BUS_NAME),
                Some(SETTINGS_INTERFACE),
                Some("SettingChanged"),
                Some(PORTAL_OBJECT_PATH),
                Some(APPEARANCE_NAMESPACE),
                gio::DBusSignalFlags::NONE,
                {
                    let follower = follower.clone();
                    move |_, _, _, _, _, parameters| follower.on_setting_changed(parameters)
                },
            );
            read_color_scheme(&connection, follower, READ_ONE_METHOD);
            SUBSCRIPTION.with(|slot| {
                if let Some((previous, id)) = slot.replace(Some((connection, subscription))) {
                    previous.signal_unsubscribe(id);
                }
            });
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[derive(Default)]
    struct FakeSetting {
        value: Cell<bool>,
        writes: RefCell<Vec<bool>>,
    }

    impl PreferDarkSetting for &FakeSetting {
        fn prefer_dark(&self) -> bool {
            self.value.get()
        }

        fn set_prefer_dark(&self, prefer_dark: bool) {
            self.value.set(prefer_dark);
            self.writes.borrow_mut().push(prefer_dark);
        }
    }

    fn setting_changed(namespace: &str, key: &str, value: glib::Variant) -> glib::Variant {
        (namespace, key, value).to_variant()
    }

    fn color_scheme_signal(value: u32) -> glib::Variant {
        setting_changed(APPEARANCE_NAMESPACE, COLOR_SCHEME_KEY, value.to_variant())
    }

    fn portal_error() -> glib::Error {
        glib::Error::new(gio::IOErrorEnum::Failed, "no such method")
    }

    #[test]
    fn kde_switches_flip_gtk_preference_live() {
        let setting = FakeSetting::default();
        let follower = Follower::new(&setting);
        follower.on_setting_changed(&color_scheme_signal(1));
        assert!(setting.value.get());
        follower.on_setting_changed(&color_scheme_signal(2));
        assert!(!setting.value.get());
        assert_eq!(*setting.writes.borrow(), vec![true, false]);
    }

    #[test]
    fn gnome_default_withdraws_the_dark_override() {
        let setting = FakeSetting::default();
        let follower = Follower::new(&setting);
        follower.on_setting_changed(&color_scheme_signal(1));
        follower.on_setting_changed(&color_scheme_signal(0));
        assert!(!setting.value.get());
    }

    #[test]
    fn no_preference_restores_a_dark_gtk_startup_value() {
        let setting = FakeSetting::default();
        setting.value.set(true);
        let follower = Follower::new(&setting);
        follower.on_setting_changed(&color_scheme_signal(2));
        follower.on_setting_changed(&color_scheme_signal(0));
        assert!(setting.value.get());
        follower.on_setting_changed(&color_scheme_signal(7));
        assert_eq!(*setting.writes.borrow(), vec![false, true]);
    }

    #[test]
    fn ignores_other_settings_and_malformed_signals() {
        let setting = FakeSetting::default();
        let follower = Follower::new(&setting);
        follower.on_setting_changed(&setting_changed(
            APPEARANCE_NAMESPACE,
            "accent-color",
            1u32.to_variant(),
        ));
        follower.on_setting_changed(&setting_changed(
            "org.gnome.desktop.interface",
            COLOR_SCHEME_KEY,
            1u32.to_variant(),
        ));
        follower.on_setting_changed(&setting_changed(
            APPEARANCE_NAMESPACE,
            COLOR_SCHEME_KEY,
            "prefer-dark".to_variant(),
        ));
        follower.on_setting_changed(&1u32.to_variant());
        assert!(setting.writes.borrow().is_empty());
    }

    #[test]
    fn startup_read_applies_and_falls_back_to_legacy_read_once() {
        let setting = FakeSetting::default();
        let follower = Follower::new(&setting);
        let boxed = glib::Variant::from_variant(&1u32.to_variant());
        assert_eq!(
            follower.on_read_reply(READ_ONE_METHOD, Err(portal_error())),
            Some(LEGACY_READ_METHOD)
        );
        assert!(setting.writes.borrow().is_empty());
        let legacy_reply = glib::Variant::tuple_from_iter([glib::Variant::from_variant(&boxed)]);
        assert_eq!(
            follower.on_read_reply(LEGACY_READ_METHOD, Ok(legacy_reply)),
            None
        );
        assert!(setting.value.get());
    }

    #[test]
    fn failed_reads_leave_gtk_untouched() {
        let setting = FakeSetting::default();
        setting.value.set(true);
        let follower = Follower::new(&setting);
        assert_eq!(
            follower.on_read_reply(LEGACY_READ_METHOD, Err(portal_error())),
            None
        );
        assert_eq!(
            follower.on_read_reply(READ_ONE_METHOD, Ok("dark".to_variant())),
            None
        );
        assert!(setting.value.get());
        assert!(setting.writes.borrow().is_empty());
    }

    #[test]
    fn unwraps_read_one_read_and_signal_shapes() {
        let inner = 1u32.to_variant();
        let read_one = glib::Variant::tuple_from_iter([glib::Variant::from_variant(&inner)]);
        let read = glib::Variant::tuple_from_iter([glib::Variant::from_variant(
            &glib::Variant::from_variant(&inner),
        )]);
        assert_eq!(color_scheme_from_variant(&read_one), Some(1));
        assert_eq!(color_scheme_from_variant(&read), Some(1));
        assert_eq!(
            color_scheme_from_variant(&glib::Variant::from_variant(&inner)),
            Some(1)
        );
        assert_eq!(color_scheme_from_variant(&"dark".to_variant()), None);
        assert_eq!(color_scheme_from_variant(&(1u32, 2u32).to_variant()), None);
    }
}
