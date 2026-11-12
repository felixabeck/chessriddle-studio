use std::borrow::Cow;

pub(super) fn canonical(date: &str) -> Cow<'_, str> {
    if date.len() == 10 {
        return Cow::Borrowed(date);
    }
    let mut parts = date.split('.');
    let (Some(year), Some(month), Some(day), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Cow::Borrowed(date);
    };
    if year.len() != 4
        || !(1..=2).contains(&month.len())
        || !(1..=2).contains(&day.len())
        || ![year, month, day].into_iter().all(|part| {
            part.bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'?')
        })
    {
        return Cow::Borrowed(date);
    }
    let mut result = String::with_capacity(10);
    result.push_str(year);
    for part in [month, day] {
        result.push('.');
        if part.len() == 1 {
            result.push(if part == "?" { '?' } else { '0' });
        }
        result.push_str(part);
    }
    Cow::Owned(result)
}

pub(super) fn canonical_sql(expr: &str) -> String {
    let expr = format!("({expr})");
    let year = "[0-9?][0-9?][0-9?][0-9?]";
    let mut sql = String::from("CASE");
    for (month_len, day_len) in [(1, 1), (1, 2), (2, 1)] {
        let pattern = format!(
            "{year}.{}.{}",
            "[0-9?]".repeat(month_len),
            "[0-9?]".repeat(day_len)
        );
        let month = format!("substr({expr}, 6, {month_len})");
        let day = format!("substr({expr}, {}, {day_len})", 7 + month_len);
        let month = if month_len == 1 {
            format!("CASE {month} WHEN '?' THEN '??' ELSE '0' || {month} END")
        } else {
            month
        };
        let day = if day_len == 1 {
            format!("CASE {day} WHEN '?' THEN '??' ELSE '0' || {day} END")
        } else {
            day
        };
        sql.push_str(&format!(
            " WHEN length(CAST({expr} AS BLOB)) = {} AND {expr} GLOB '{pattern}' \
             THEN substr({expr}, 1, 4) || '.' || {month} || '.' || {day}",
            6 + month_len + day_len
        ));
    }
    sql.push_str(&format!(" ELSE {expr} END"));
    sql
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::{
        prelude::*,
        sql_types::{Nullable, Text},
    };

    const CASES: &[(&str, &str)] = &[
        ("2026.1.15", "2026.01.15"),
        ("2026.9.30", "2026.09.30"),
        ("2026.10.1", "2026.10.01"),
        ("2026.1.?", "2026.01.??"),
        ("2026.?.?", "2026.??.??"),
        ("????.?.?", "????.??.??"),
        ("2026.?.15", "2026.??.15"),
        ("202?.?9.1", "202?.?9.01"),
        ("2026.1.1", "2026.01.01"),
        ("2026.01.15", "2026.01.15"),
        ("????.??.??", "????.??.??"),
        ("2026.0?.?5", "2026.0?.?5"),
        ("", ""),
        ("????", "????"),
        ("invalid", "invalid"),
        ("2026.123.1", "2026.123.1"),
        ("2026.1.123", "2026.1.123"),
        ("2026.1.15x", "2026.1.15x"),
        ("2026.1.1\0", "2026.1.1\0"),
        ("2026.１.1", "2026.１.1"),
        ("２０２６.1.1", "２０２６.1.1"),
        ("éé.1.1", "éé.1.1"),
        ("2026..1", "2026..1"),
        ("2026.1.1.", "2026.1.1."),
    ];

    #[test]
    fn canonical_pads_only_unpadded_pgn_shapes() {
        for &(input, expected) in CASES {
            let actual = canonical(input);
            assert_eq!(actual, expected, "{input:?}");
            assert_eq!(
                matches!(actual, Cow::Borrowed(_)),
                input == expected,
                "{input:?}"
            );
        }
    }

    #[test]
    fn canonical_sql_matches_rust_including_null() {
        #[derive(QueryableByName)]
        struct Row {
            #[diesel(sql_type = Nullable<Text>)]
            value: Option<String>,
        }

        let mut db = SqliteConnection::establish(":memory:").unwrap();
        let sql = format!(
            "SELECT {} AS value FROM (SELECT ? AS input)",
            canonical_sql("input")
        );
        for input in CASES.iter().map(|(input, _)| Some(*input)).chain([None]) {
            let row = diesel::sql_query(&sql)
                .bind::<Nullable<Text>, _>(input)
                .get_result::<Row>(&mut db)
                .unwrap();
            assert_eq!(
                row.value.as_deref(),
                input.map(canonical).as_deref(),
                "{input:?}"
            );
        }
    }
}
