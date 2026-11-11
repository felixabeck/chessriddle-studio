use caseless::Caseless;
use diesel::{
    prelude::*,
    sql_types::{Nullable, Text},
};
use unicode_normalization::UnicodeNormalization;

/// Search and semantic identity only. Linked-game header signatures stay byte-exact.
pub(super) fn normalize_name(value: &str) -> String {
    value.nfd().default_case_fold().nfc().collect()
}

diesel::sql_function! {
    fn normalized_name(value: Nullable<Text>) -> Nullable<Text>;
}

pub(super) fn register(conn: &mut SqliteConnection) -> QueryResult<()> {
    normalized_name::register_impl(conn, |value: Option<String>| {
        value.map(|value| normalize_name(&value))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_use_canonical_composition_and_full_case_folding() {
        for (left, right) in [
            ("José", "Jose\u{301}"),
            ("Müller", "MÜLLER"),
            ("Straße", "STRASSE"),
            ("Σίσυφος", "ΣΊΣΥΦΟΣ"),
        ] {
            assert_eq!(normalize_name(left), normalize_name(right));
        }
        assert_eq!(normalize_name("Jose\u{301}"), "josé");
        assert_ne!(normalize_name("José"), normalize_name("Jose"));
        assert_eq!(normalize_name("Player"), "player");
    }
}
