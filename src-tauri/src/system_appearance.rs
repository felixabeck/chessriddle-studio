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

use gtk::gio;
use gtk::glib;
use gtk::prelude::*;

const PORTAL_BUS_NAME: &str = "org.freedesktop.portal.Desktop";
const PORTAL_OBJECT_PATH: &str = "/org/freedesktop/portal/desktop";
const SETTINGS_INTERFACE: &str = "org.freedesktop.portal.Settings";
const APPEARANCE_NAMESPACE: &str = "org.freedesktop.appearance";
const COLOR_SCHEME_KEY: &str = "color-scheme";
const READ_TIMEOUT_MS: i32 = 2_000;

thread_local! {
    // Keeps the connection and its subscription alive on the main thread for the process lifetime.
    static SUBSCRIPTION: std::cell::RefCell<Option<(gio::DBusConnection, gio::SignalSubscriptionId)>> =
        const { std::cell::RefCell::new(None) };
}

/// Maps the portal's `color-scheme` value to GTK's dark preference. `0` means "no preference"
/// and any unknown value is ignored, so GTK keeps the theme the user configured for it.
fn prefer_dark_from_color_scheme(value: u32) -> Option<bool> {
    match value {
        1 => Some(true),
        2 => Some(false),
        _ => None,
    }
}

/// Unwraps the `color-scheme` value from a portal reply or signal value. `ReadOne` replies
/// `(v)` holding `u`; the older `Read` replies `(v)` holding `v` holding `u`; a signal value is
/// `v` holding `u`. Any other shape yields `None`.
fn color_scheme_from_variant(variant: &glib::Variant) -> Option<u32> {
    let mut current = variant.clone();
    for _ in 0..4 {
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

fn apply_color_scheme(value: u32) {
    let Some(prefer_dark) = prefer_dark_from_color_scheme(value) else {
        return;
    };
    let Some(settings) = gtk::Settings::default() else {
        log::warn!("GTK settings are unavailable; the desktop colour scheme is not applied");
        return;
    };
    if settings.is_gtk_application_prefer_dark_theme() != prefer_dark {
        log::info!("desktop colour scheme changed, prefer dark theme: {prefer_dark}");
        settings.set_gtk_application_prefer_dark_theme(prefer_dark);
    }
}

fn read_color_scheme(connection: &gio::DBusConnection, method: &'static str) {
    let fallback = connection.clone();
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
        move |reply| match reply {
            Ok(reply) => {
                if let Some(value) = color_scheme_from_variant(&reply) {
                    apply_color_scheme(value);
                }
            }
            // Portal interface version 1 has only `Read`.
            Err(_) if method == "ReadOne" => read_color_scheme(&fallback, "Read"),
            Err(error) => log::info!("desktop colour scheme could not be read: {error}"),
        },
    );
}

/// Starts following the desktop colour scheme. Must run on the GTK main thread (Tauri's
/// `setup`), whose main context dispatches the D-Bus callbacks.
pub fn follow_desktop_color_scheme() {
    gio::bus_get(
        gio::BusType::Session,
        None::<&gio::Cancellable>,
        |connection| {
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
                |_, _, _, _, _, parameters| {
                    if let Some(value) = color_scheme_from_setting_changed(parameters) {
                        apply_color_scheme(value);
                    }
                },
            );
            read_color_scheme(&connection, "ReadOne");
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

    #[test]
    fn maps_portal_values_to_gtk_preference() {
        assert_eq!(prefer_dark_from_color_scheme(0), None);
        assert_eq!(prefer_dark_from_color_scheme(1), Some(true));
        assert_eq!(prefer_dark_from_color_scheme(2), Some(false));
        assert_eq!(prefer_dark_from_color_scheme(3), None);
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

    fn setting_changed(namespace: &str, key: &str, value: glib::Variant) -> glib::Variant {
        (namespace, key, value).to_variant()
    }

    #[test]
    fn reads_only_the_appearance_color_scheme_signal() {
        assert_eq!(
            color_scheme_from_setting_changed(&setting_changed(
                APPEARANCE_NAMESPACE,
                COLOR_SCHEME_KEY,
                2u32.to_variant()
            )),
            Some(2)
        );
        assert_eq!(
            color_scheme_from_setting_changed(&setting_changed(
                APPEARANCE_NAMESPACE,
                "accent-color",
                2u32.to_variant()
            )),
            None
        );
        assert_eq!(
            color_scheme_from_setting_changed(&setting_changed(
                "org.gnome.desktop.interface",
                COLOR_SCHEME_KEY,
                "prefer-dark".to_variant()
            )),
            None
        );
        assert_eq!(color_scheme_from_setting_changed(&1u32.to_variant()), None);
    }
}
