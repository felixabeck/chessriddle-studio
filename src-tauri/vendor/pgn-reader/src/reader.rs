use std::{
    cmp::min,
    io::{self, Chain, Cursor, Read},
};

use shakmaty::{
    san::{San, SanPlus, Suffix},
    CastlingSide, Color, Outcome,
};

// use slice_deque::SliceDeque;
use crate::{
    types::{Nag, RawComment, RawHeader, Skip},
    visitor::{SkipVisitor, UnvisitedKind, Visitor},
};

const MIN_BUFFER_SIZE: usize = 8192;
// Matches ChessFable's per-game MAX_PGN_BYTES in src-tauri/src/pgn.rs.
const MAX_TOKEN_BYTES: usize = 10 * 1024 * 1024;

trait ReadPgn {
    type Err;

    /// Fill the buffer. The buffer must then contain at least MIN_BUFFER_SIZE
    /// bytes or all remaining bytes until the end of the source.
    fn fill_buffer_and_peek(&mut self) -> Result<Option<u8>, Self::Err>;

    /// Retain the current token and read more, bounded by the token cap plus
    /// one byte for its terminator. Returns false at EOF or the cap.
    fn fill_more(&mut self) -> Result<bool, Self::Err>;

    /// Returns the current buffer.
    fn buffer(&self) -> &[u8];

    /// Consume n bytes from the buffer.
    fn consume(&mut self, n: usize);

    /// Constructs a parser error.
    fn invalid_data() -> Self::Err;

    fn peek(&self) -> Option<u8> {
        self.buffer().first().cloned()
    }

    fn bump(&mut self) -> Option<u8> {
        let head = self.peek();
        if head.is_some() {
            self.consume(1);
        }
        head
    }

    fn remaining(&self) -> usize {
        self.buffer().len()
    }

    /// Find a delimiter while retaining the token, bounded by MAX_TOKEN_BYTES.
    /// Returns None at EOF or when the delimiter would exceed the cap.
    fn find_bounded<F>(&mut self, needle: F) -> Result<Option<usize>, Self::Err>
    where
        F: Fn(&[u8]) -> Option<usize>,
    {
        let mut searched = 0;
        loop {
            if let Some(delta) = needle(&self.buffer()[searched..]) {
                let pos = searched + delta;
                return Ok((pos <= MAX_TOKEN_BYTES).then_some(pos));
            }
            searched = self.remaining();
            if !self.fill_more()? {
                return Ok(None);
            }
        }
    }

    fn consume_all(&mut self) {
        let remaining = self.remaining();
        self.consume(remaining);
    }

    fn skip_bom(&mut self) -> Result<(), Self::Err> {
        self.fill_buffer_and_peek()?;
        if self.buffer().starts_with(b"\xef\xbb\xbf") {
            self.consume(3);
        }
        Ok(())
    }

    fn skip_until(&mut self, needle: u8) -> Result<(), Self::Err> {
        while self.fill_buffer_and_peek()?.is_some() {
            if let Some(pos) = memchr::memchr(needle, self.buffer()) {
                self.consume(pos);
                return Ok(());
            } else {
                self.consume_all();
            }
        }

        Ok(())
    }

    fn skip_line(&mut self) -> Result<(), Self::Err> {
        self.skip_until(b'\n')?;
        self.bump();
        Ok(())
    }

    fn skip_whitespace(&mut self) -> Result<(), Self::Err> {
        while let Some(ch) = self.fill_buffer_and_peek()? {
            match ch {
                b' ' | b'\t' | b'\r' | b'\n' => {
                    self.bump();
                }
                b'%' => {
                    self.bump();
                    self.skip_line()?;
                }
                _ => return Ok(()),
            }
        }

        Ok(())
    }

    fn skip_ket(&mut self) -> Result<(), Self::Err> {
        while let Some(ch) = self.fill_buffer_and_peek()? {
            match ch {
                b' ' | b'\t' | b'\r' | b']' => {
                    self.bump();
                }
                b'%' => {
                    self.bump();
                    self.skip_line()?;
                    return Ok(());
                }
                b'\n' => {
                    self.bump();
                    return Ok(());
                }
                _ => {
                    return Ok(());
                }
            }
        }

        Ok(())
    }

    fn read_headers<V: Visitor>(&mut self, visitor: &mut V) -> Result<(), Self::Err> {
        while let Some(ch) = self.fill_buffer_and_peek()? {
            match ch {
                b'[' => {
                    self.bump();

                    let delimiter = match self
                        .find_bounded(|bytes| memchr::memchr3(b'"', b'\n', b']', bytes))?
                    {
                        Some(pos) => pos,
                        None => {
                            self.consume_all();
                            self.skip_line()?;
                            return Err(Self::invalid_data());
                        }
                    };
                    let left_quote = if self.buffer()[delimiter] == b'"' {
                        delimiter
                    } else {
                        self.consume(delimiter + 1);
                        self.skip_ket()?;
                        continue;
                    };

                    let mut key_end = left_quote;
                    while key_end > 0 && matches!(self.buffer()[key_end - 1], b' ' | b'\t') {
                        key_end -= 1;
                    }

                    let value_start = left_quote + 1;
                    let mut right_quote = value_start;
                    let consumed = loop {
                        match memchr::memchr3(b'\\', b'"', b'\n', &self.buffer()[right_quote..]) {
                            Some(delta) if self.buffer()[right_quote + delta] == b'"' => {
                                right_quote += delta;
                                break right_quote + 1;
                            }
                            Some(delta) if self.buffer()[right_quote + delta] == b'\n' => {
                                right_quote += delta;
                                break right_quote;
                            }
                            Some(delta) => {
                                // Skip escaped character.
                                if right_quote + delta + 1 == self.remaining()
                                    && self.fill_more()?
                                {
                                    continue;
                                }
                                right_quote = min(right_quote + delta + 2, self.remaining());
                            }
                            None => {
                                right_quote = self.remaining();
                                if self.fill_more()? {
                                    continue;
                                }
                                self.consume_all();
                                self.skip_line()?;
                                return Err(Self::invalid_data());
                            }
                        }
                    };

                    if right_quote > MAX_TOKEN_BYTES {
                        self.consume_all();
                        self.skip_line()?;
                        return Err(Self::invalid_data());
                    }

                    visitor.header(
                        &self.buffer()[..key_end],
                        RawHeader(&self.buffer()[value_start..right_quote]),
                    );
                    self.consume(consumed);
                    self.skip_ket()?;
                }
                b'%' => self.skip_line()?,
                b' ' | b'\t' | b'\r' => {
                    self.bump();
                }
                _ => return Ok(()),
            }
        }

        Ok(())
    }

    /// Inspect the line after a movetext newline. The newline is still in the
    /// buffer. A `[` line always ends the game or skipped variation. A blank
    /// line ends only when `end_on_blank` is set (a termination marker was
    /// already read outside comments and outside variations). On a boundary
    /// the newline stays so the enclosing movetext loop and the next
    /// `read_game` still see it. Percent lines keep their terminating newline.
    fn movetext_line_boundary(&mut self, end_on_blank: bool) -> Result<bool, Self::Err> {
        self.movetext_line_boundary_with(end_on_blank, None::<&mut SkipVisitor>)
    }

    fn movetext_line_boundary_with<V: Visitor>(
        &mut self,
        end_on_blank: bool,
        mut visitor: Option<&mut V>,
    ) -> Result<bool, Self::Err> {
        self.fill_buffer_and_peek()?;
        let mut i = 1;
        loop {
            while self.remaining() <= i {
                if !self.fill_more()? {
                    self.bump();
                    return Ok(false);
                }
            }
            match self.buffer()[i] {
                b' ' | b'\t' | b'\r' => {
                    i += 1;
                }
                b'%' => {
                    self.consume(i);
                    if let Some(visitor) = visitor.as_deref_mut() {
                        self.read_unvisited_line(visitor, UnvisitedKind::Discarded)?;
                    } else {
                        self.skip_until(b'\n')?;
                    }
                    return Ok(false);
                }
                b'[' => return Ok(true),
                b'\n' => {
                    if end_on_blank {
                        return Ok(true);
                    }
                    self.consume(i);
                    return Ok(false);
                }
                _ => {
                    self.consume(i);
                    return Ok(false);
                }
            }
        }
    }

    fn take_outcome_after_one(&mut self) -> Option<Outcome> {
        self.take_outcome_after_one_at(0)
    }

    fn take_outcome_after_one_at(&mut self, start: usize) -> Option<Outcome> {
        if self.buffer()[start..].starts_with(b"-0") {
            self.consume(start + 2);
            Some(Outcome::Decisive {
                winner: Color::White,
            })
        } else if self.buffer()[start..].starts_with(b"/2-1/2") {
            self.consume(start + 6);
            Some(Outcome::Draw)
        } else {
            None
        }
    }

    fn take_outcome_after_zero(&mut self) -> Option<Outcome> {
        self.take_outcome_after_zero_at(0)
    }

    fn take_outcome_after_zero_at(&mut self, start: usize) -> Option<Outcome> {
        if self.buffer()[start..].starts_with(b"-1") {
            self.consume(start + 2);
            Some(Outcome::Decisive {
                winner: Color::Black,
            })
        } else {
            None
        }
    }

    fn find_skip_movetext_byte(bytes: &[u8]) -> Option<usize> {
        bytes
            .iter()
            .position(|&ch| matches!(ch, b'\n' | b'{' | b';' | b'(' | b')' | b'*' | b'1' | b'0'))
    }

    fn skip_movetext(&mut self) -> Result<(), Self::Err> {
        let mut depth = 0usize;
        let mut terminated = false;
        while let Some(ch) = self.fill_buffer_and_peek()? {
            match ch {
                b'{' => {
                    self.bump();
                    self.skip_until(b'}')?;
                    self.bump();
                }
                b';' => {
                    self.bump();
                    self.skip_until(b'\n')?;
                }
                b'\n' => {
                    if self.movetext_line_boundary(terminated && depth == 0)? {
                        break;
                    }
                }
                b'(' => {
                    self.bump();
                    depth += 1;
                }
                b')' => {
                    self.bump();
                    depth = depth.saturating_sub(1);
                }
                b'*' => {
                    self.bump();
                    if depth == 0 {
                        terminated = true;
                    }
                }
                b'1' => {
                    self.bump();
                    if self.take_outcome_after_one().is_some() {
                        if depth == 0 {
                            terminated = true;
                        }
                    } else {
                        let token_end = self.find_token_end(0);
                        self.consume(token_end);
                    }
                }
                b'0' => {
                    self.bump();
                    if self.take_outcome_after_zero().is_some() {
                        if depth == 0 {
                            terminated = true;
                        }
                    } else {
                        let token_end = self.find_token_end(0);
                        self.consume(token_end);
                    }
                }
                _ => {
                    if let Some(consumed) = Self::find_skip_movetext_byte(self.buffer()) {
                        self.consume(consumed);
                    } else {
                        self.consume_all();
                    }
                }
            }
        }

        Ok(())
    }

    fn find_token_end(&mut self, start: usize) -> usize {
        let mut end = start;
        for &ch in &self.buffer()[start..] {
            match ch {
                b' ' | b'\t' | b'\n' | b'\r' | b'{' | b'}' | b'(' | b')' | b'!' | b'?' | b'$'
                | b';' | b'.' => break,
                _ => end += 1,
            }
        }
        end
    }

    fn read_unvisited_line<V: Visitor>(
        &mut self,
        visitor: &mut V,
        kind: UnvisitedKind,
    ) -> Result<(), Self::Err> {
        loop {
            let newline = self.find_bounded(|bytes| memchr::memchr(b'\n', bytes))?;
            let end = newline.unwrap_or(self.remaining());
            let text = &self.buffer()[..end];
            visitor.unvisited(kind, text.strip_suffix(b"\r").unwrap_or(text));
            self.consume(end);
            if newline.is_some() || self.fill_buffer_and_peek()?.is_none() {
                return Ok(());
            }
        }
    }

    fn read_move_number_or_discarded<V: Visitor>(&mut self, visitor: &mut V) {
        let end = self.find_token_end(1);
        if !self.buffer()[..end].iter().all(u8::is_ascii_digit) {
            visitor.unvisited(UnvisitedKind::Discarded, &self.buffer()[..end]);
        }
        self.consume(end);
    }

    fn read_movetext<V: Visitor>(&mut self, visitor: &mut V) -> Result<(), Self::Err> {
        let mut depth = 0usize;
        let mut terminated = false;
        while let Some(ch) = self.fill_buffer_and_peek()? {
            match ch {
                b'{' => {
                    self.bump();

                    let right_brace =
                        match self.find_bounded(|bytes| memchr::memchr(b'}', bytes))? {
                            Some(pos) => pos,
                            None => {
                                self.consume_all();
                                self.skip_until(b'}')?;
                                self.bump();
                                return Err(Self::invalid_data());
                            }
                        };

                    visitor.comment(RawComment(&self.buffer()[..right_brace]));
                    self.consume(right_brace + 1);
                }
                b'\n' => {
                    if self.movetext_line_boundary_with(terminated && depth == 0, Some(visitor))? {
                        break;
                    }
                }
                b';' => {
                    self.bump();
                    self.read_unvisited_line(visitor, UnvisitedKind::LineComment)?;
                }
                b'1' => {
                    if let Some(outcome) = self.take_outcome_after_one_at(1) {
                        if depth == 0 {
                            terminated = true;
                        }
                        visitor.outcome(Some(outcome));
                    } else {
                        self.read_move_number_or_discarded(visitor);
                    }
                }
                b'0' => {
                    if let Some(outcome) = self.take_outcome_after_zero_at(1) {
                        if depth == 0 {
                            terminated = true;
                        }
                        visitor.outcome(Some(outcome));
                    } else if self.buffer().starts_with(b"0-0") {
                        // Castling notation with zeros.
                        self.consume(3);
                        let side = if self.buffer().starts_with(b"-0") {
                            self.consume(2);
                            CastlingSide::QueenSide
                        } else {
                            CastlingSide::KingSide
                        };
                        let suffix = match self.peek() {
                            Some(b'+') => Some(Suffix::Check),
                            Some(b'#') => Some(Suffix::Checkmate),
                            _ => None,
                        };
                        if suffix.is_some() {
                            self.bump();
                        }
                        visitor.san(SanPlus {
                            san: San::Castle(side),
                            suffix,
                        });
                    } else {
                        self.read_move_number_or_discarded(visitor);
                    }
                }
                b'2'..=b'9' => self.read_move_number_or_discarded(visitor),
                b'(' => {
                    self.bump();
                    depth += 1;
                    if let Skip(true) = visitor.begin_variation() {
                        self.skip_variation()?;
                    }
                }
                b')' => {
                    self.bump();
                    depth = depth.saturating_sub(1);
                    visitor.end_variation();
                }
                b'$' => {
                    let token_end = self.find_token_end(1);
                    if let Ok(nag) = btoi::btou(&self.buffer()[1..token_end]) {
                        visitor.nag(Nag(nag));
                    } else {
                        visitor.unvisited(UnvisitedKind::Discarded, &self.buffer()[..token_end]);
                    }
                    self.consume(token_end);
                }
                b'!' => {
                    self.bump();
                    match self.peek() {
                        Some(b'!') => {
                            self.bump();
                            visitor.nag(Nag::BRILLIANT_MOVE);
                        }
                        Some(b'?') => {
                            self.bump();
                            visitor.nag(Nag::SPECULATIVE_MOVE);
                        }
                        _ => {
                            visitor.nag(Nag::GOOD_MOVE);
                        }
                    }
                }
                b'?' => {
                    self.bump();
                    match self.peek() {
                        Some(b'!') => {
                            self.bump();
                            visitor.nag(Nag::DUBIOUS_MOVE);
                        }
                        Some(b'?') => {
                            self.bump();
                            visitor.nag(Nag::BLUNDER);
                        }
                        _ => {
                            visitor.nag(Nag::MISTAKE);
                        }
                    }
                }
                b'*' => {
                    visitor.outcome(None);
                    if depth == 0 {
                        terminated = true;
                    }
                    self.bump();
                }
                b' ' | b'\t' | b'\r' | b'P' | b'.' => {
                    self.bump();
                }
                _ => {
                    let token_end = self.find_token_end(1);
                    if ch > b'9' || ch == b'-' {
                        if let Ok(san) = SanPlus::from_ascii(&self.buffer()[..token_end]) {
                            visitor.san(san);
                        } else {
                            visitor.unvisited(UnvisitedKind::Discarded, &self.buffer()[..token_end]);
                        }
                    } else {
                        visitor.unvisited(UnvisitedKind::Discarded, &self.buffer()[..token_end]);
                    }
                    self.consume(token_end);
                }
            }
        }

        Ok(())
    }

    fn skip_variation(&mut self) -> Result<(), Self::Err> {
        let mut depth = 0usize;

        while let Some(ch) = self.fill_buffer_and_peek()? {
            match ch {
                b'(' => {
                    depth += 1;
                    self.bump();
                }
                b')' => {
                    if let Some(d) = depth.checked_sub(1) {
                        self.bump();
                        depth = d;
                    } else {
                        break;
                    }
                }
                b'{' => {
                    self.bump();
                    self.skip_until(b'}')?;
                    self.bump();
                }
                b';' => {
                    self.bump();
                    self.skip_until(b'\n')?;
                }
                b'\n' => {
                    if self.movetext_line_boundary(false)? {
                        break;
                    }
                }
                _ => {
                    self.bump();
                }
            }
        }

        Ok(())
    }

    fn read_game<V: Visitor>(&mut self, visitor: &mut V) -> Result<Option<V::Result>, Self::Err> {
        self.skip_bom()?;
        self.skip_whitespace()?;

        if self.fill_buffer_and_peek()?.is_none() {
            return Ok(None);
        }

        visitor.begin_game();
        visitor.begin_headers();
        self.read_headers(visitor)?;
        if let Skip(false) = visitor.end_headers() {
            self.read_movetext(visitor)?;
        } else {
            self.skip_movetext()?;
        }

        self.skip_whitespace()?;
        Ok(Some(visitor.end_game()))
    }

    fn skip_game(&mut self) -> Result<bool, Self::Err> {
        self.read_game(&mut SkipVisitor).map(|r| r.is_some())
    }
}

/// Internal read ahead buffer.
#[derive(Debug, Clone)]
pub struct Buffer {
    inner: Vec<u8>,
    position: usize,
    end: usize,
}

impl Buffer {
    fn new() -> Buffer {
        Buffer {
            inner: vec![0; MIN_BUFFER_SIZE * 2],
            position: 0,
            end: 0,
        }
    }

    fn data(&self) -> &[u8] {
        &self.inner[self.position..self.end]
    }

    fn shift(&mut self) {
        self.inner.copy_within(self.position..self.end, 0);
        self.end -= self.position;
        self.position = 0;
    }

    fn grow(&mut self, size: usize) {
        // circular::Buffer::grow uses amortized Vec growth, which can reserve
        // past the token cap. Reserve only the requested bytes instead.
        self.inner.reserve_exact(size - self.inner.len());
        self.inner.resize(size, 0);
    }

    fn available_space(&self) -> usize {
        self.inner.len() - self.end
    }

    fn space(&mut self) -> &mut [u8] {
        &mut self.inner[self.end..]
    }

    fn fill(&mut self, size: usize) {
        self.end += size;
        if self.available_space() < self.data().len() + size {
            self.shift();
        }
    }

    fn consume(&mut self, size: usize) {
        self.position += min(size, self.data().len());
        if self.position > self.inner.len() / 2 {
            self.shift();
        }
    }
}

impl AsRef<[u8]> for Buffer {
    fn as_ref(&self) -> &[u8] {
        self.data()
    }
}

/// A buffered PGN reader.
#[derive(Debug)]
pub struct BufferedReader<R> {
    inner: R,
    buffer: Buffer,
}

impl<T: AsRef<[u8]>> BufferedReader<Cursor<T>> {
    /// Create a new reader by wrapping a byte slice in a [`Cursor`].
    ///
    /// ```
    /// use pgn_reader::BufferedReader;
    ///
    /// let pgn = b"1. e4 e5 *";
    /// let reader = BufferedReader::new_cursor(&pgn[..]);
    /// ```
    ///
    /// [`Cursor`]: https://doc.rust-lang.org/std/io/struct.Cursor.html
    pub fn new_cursor(inner: T) -> BufferedReader<Cursor<T>> {
        BufferedReader::new(Cursor::new(inner))
    }
}

impl<R: Read> BufferedReader<R> {
    /// Create a new buffered PGN reader.
    ///
    /// ```
    /// # use std::io;
    /// # fn try_main() -> io::Result<()> {
    /// use std::fs::File;
    /// use pgn_reader::BufferedReader;
    ///
    /// let file = File::open("example.pgn")?;
    /// let reader = BufferedReader::new(file);
    /// # Ok(())
    /// # }
    /// ```
    pub fn new(inner: R) -> BufferedReader<R> {
        BufferedReader {
            inner,
            buffer: Buffer::new(),
        }
    }

    /// Read a single game, if any, and returns the result produced by the
    /// visitor. Returns Ok(None) if the underlying reader is empty.
    ///
    /// # Errors
    ///
    /// * I/O error from the underlying reader.
    /// * Irrecoverable parser errors.
    pub fn read_game<V: Visitor>(&mut self, visitor: &mut V) -> io::Result<Option<V::Result>> {
        ReadPgn::read_game(self, visitor)
    }

    /// Skip a single game, if any.
    ///
    /// # Errors
    ///
    /// * I/O error from the underlying reader.
    /// * Irrecoverable parser errors.
    pub fn skip_game<V: Visitor>(&mut self) -> io::Result<bool> {
        ReadPgn::skip_game(self)
    }

    /// Read all games.
    ///
    /// # Errors
    ///
    /// * I/O error from the underlying reader.
    /// * Irrecoverable parser errors.
    pub fn read_all<V: Visitor>(&mut self, visitor: &mut V) -> io::Result<()> {
        while self.read_game(visitor)?.is_some() {}
        Ok(())
    }

    /// Create an iterator over all games.
    ///
    /// # Errors
    ///
    /// * I/O error from the underlying reader.
    /// * Irrecoverable parser errors.
    pub fn into_iter<V: Visitor>(self, visitor: &mut V) -> IntoIter<'_, V, R> {
        IntoIter {
            reader: self,
            visitor,
        }
    }

    /// Gets the remaining bytes in the buffer and the underlying reader.
    pub fn into_inner(self) -> Chain<Cursor<Buffer>, R> {
        Cursor::new(self.buffer).chain(self.inner)
    }

    /// Returns whether the reader has another game to parse, but does not
    /// actually parse it.
    ///
    /// # Errors
    ///
    /// * I/O error from the underlying reader.
    pub fn has_more(&mut self) -> io::Result<bool> {
        self.skip_bom()?;
        self.skip_whitespace()?;
        Ok(self.fill_buffer_and_peek()?.is_some())
    }
}

impl<R: Read> ReadPgn for BufferedReader<R> {
    type Err = io::Error;

    fn fill_more(&mut self) -> io::Result<bool> {
        self.buffer.shift();
        if self.buffer.available_space() == 0 {
            let capacity = self.buffer.inner.len();
            if capacity >= MAX_TOKEN_BYTES + 1 {
                return Ok(false);
            }
            self.buffer.grow(min(capacity * 2, MAX_TOKEN_BYTES + 1));
        }
        let size = self.inner.read(self.buffer.space())?;
        self.buffer.fill(size);
        Ok(size != 0)
    }

    fn fill_buffer_and_peek(&mut self) -> io::Result<Option<u8>> {
        while self.buffer.data().len() < MIN_BUFFER_SIZE {
            let remainder = self.buffer.space();
            let size = self.inner.read(remainder)?;

            if size == 0 {
                break;
            }

            self.buffer.fill(size);
        }

        Ok(self.buffer.data().first().cloned())
    }

    fn invalid_data() -> io::Error {
        io::Error::from(io::ErrorKind::InvalidData)
    }

    fn buffer(&self) -> &[u8] {
        self.buffer.data()
    }

    fn consume(&mut self, bytes: usize) {
        self.buffer.consume(bytes);
    }

    fn peek(&self) -> Option<u8> {
        self.buffer.data().first().cloned()
    }
}

/// Iterator returned by
/// [`BufferedReader::into_iter()`](struct.BufferedReader.html#method.into_iter).
#[derive(Debug)]
#[must_use]
pub struct IntoIter<'a, V: 'a, R> {
    visitor: &'a mut V,
    reader: BufferedReader<R>,
}

impl<'a, V: Visitor, R: Read> Iterator for IntoIter<'a, V, R> {
    type Item = Result<V::Result, io::Error>;

    fn next(&mut self) -> Option<Self::Item> {
        match self.reader.read_game(self.visitor) {
            Ok(Some(result)) => Some(Ok(result)),
            Ok(None) => None,
            Err(err) => Some(Err(err)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct _AssertObjectSafe<R>(Box<BufferedReader<R>>);

    struct GameCounter {
        count: usize,
    }

    impl Default for GameCounter {
        fn default() -> GameCounter {
            GameCounter { count: 0 }
        }
    }

    impl Visitor for GameCounter {
        type Result = ();

        fn end_game(&mut self) {
            self.count += 1;
        }
    }

    fn assert_header_events(pgn: &str, expected: &[&[u8]]) -> Result<(), io::Error> {
        struct Events {
            event: Vec<u8>,
            skip: bool,
        }

        impl Visitor for Events {
            type Result = Vec<u8>;

            fn header(&mut self, key: &[u8], value: RawHeader<'_>) {
                if key == b"Event" {
                    self.event = value.as_bytes().to_vec();
                }
            }

            fn end_headers(&mut self) -> Skip {
                Skip(self.skip)
            }

            fn end_game(&mut self) -> Self::Result {
                std::mem::take(&mut self.event)
            }
        }

        for skip in [false, true] {
            let mut reader = BufferedReader::new(io::Cursor::new(pgn.as_bytes()));
            let mut visitor = Events {
                event: Vec::new(),
                skip,
            };
            let mut events = Vec::new();
            while let Some(event) = reader.read_game(&mut visitor)? {
                events.push(event);
            }
            assert_eq!(events, expected, "skip={skip}, pgn={pgn:?}");
        }
        Ok(())
    }

    #[test]
    fn test_header_key_horizontal_separators() -> Result<(), io::Error> {
        struct Headers {
            headers: Vec<(Vec<u8>, Vec<u8>)>,
            skip: bool,
        }

        impl Visitor for Headers {
            type Result = Vec<(Vec<u8>, Vec<u8>)>;

            fn header(&mut self, key: &[u8], value: RawHeader<'_>) {
                self.headers.push((key.to_vec(), value.as_bytes().to_vec()));
            }

            fn end_headers(&mut self) -> Skip {
                Skip(self.skip)
            }

            fn end_game(&mut self) -> Self::Result {
                std::mem::take(&mut self.headers)
            }
        }

        let mut failures = Vec::new();
        for skip in [false, true] {
            for separator in [" ", "  ", "   ", "\t", "\t\t", " \t ", "\t \t"] {
                for (name, value) in [
                    ("Event", " A\t\\\"é\\\\Z "),
                    ("FEN", "8/8/8/8/8/8/4K3/7k w - - 0 1"),
                    ("X Y\tZ\u{a0}", " raw "),
                ] {
                    let pgn = format!("[{name}{separator}\"{value}\"]\n\n*");
                    let mut reader = BufferedReader::new_cursor(pgn.as_bytes());
                    let mut visitor = Headers {
                        headers: Vec::new(),
                        skip,
                    };
                    let actual = reader.read_game(&mut visitor)?;
                    let expected =
                        Some(vec![(name.as_bytes().to_vec(), value.as_bytes().to_vec())]);
                    eprintln!("skip={skip}, separator={separator:?}, callbacks={actual:?}");
                    if actual != expected {
                        failures.push(format!(
                            "skip={skip}, separator={separator:?}, actual={actual:?}, expected={expected:?}"
                        ));
                    }
                    assert!(reader.read_game(&mut visitor)?.is_none());
                }
            }
        }
        assert!(failures.is_empty(), "raw header callbacks: {failures:#?}");
        Ok(())
    }

    #[test]
    fn test_header_horizontal_continuation() -> Result<(), io::Error> {
        for indent in [" ", "\t", " \t"] {
            for continuation in ["[Site \"X\"]", "% comment", "% first\n\t% second"] {
                assert_header_events(
                    &format!("[Event \"A\"]\n{indent}{continuation}\n[Event \"B\"]\n"),
                    &[b"B"],
                )?;
            }
        }
        Ok(())
    }

    #[test]
    fn test_indented_game_boundary() -> Result<(), io::Error> {
        for indent in [" ", "\t", " \t"] {
            for separator in ["\n", " \t\n", "\r\n", " \t\r\n"] {
                assert_header_events(
                    &format!("[Event \"A\"]\n{separator}{indent}[Event \"B\"]\n"),
                    &[b"A", b"B"],
                )?;
            }
        }
        Ok(())
    }

    #[test]
    fn test_percent_game_boundary() -> Result<(), io::Error> {
        for moves in ["", "1. e4 *\n"] {
            for escapes in ["% comment\n", "% first\n\t% second\n"] {
                assert_header_events(
                    &format!("[Event \"A\"]\n\n{moves}{escapes}[Event \"B\"]\n"),
                    &[b"A", b"B"],
                )?;
            }
        }
        Ok(())
    }

    #[test]
    fn test_empty_game() -> Result<(), io::Error> {
        let mut counter = GameCounter::default();
        let mut reader = BufferedReader::new(io::Cursor::new(b"  "));
        reader.read_game(&mut counter)?;
        assert_eq!(counter.count, 0);
        Ok(())
    }

    #[test]
    fn test_trailing_space() -> Result<(), io::Error> {
        let mut counter = GameCounter::default();
        let mut reader = BufferedReader::new(io::Cursor::new(b"1. e4 1-0\n\n\n\n\n  \n"));
        reader.read_game(&mut counter)?;
        assert_eq!(counter.count, 1);
        reader.read_game(&mut counter)?;
        assert_eq!(counter.count, 1);
        Ok(())
    }

    #[test]
    fn test_nag() -> Result<(), io::Error> {
        struct NagCollector {
            nags: Vec<Nag>,
        }

        impl Visitor for NagCollector {
            type Result = ();

            fn nag(&mut self, nag: Nag) {
                self.nags.push(nag);
            }

            fn end_game(&mut self) {}
        }

        let mut collector = NagCollector { nags: Vec::new() };
        let mut reader = BufferedReader::new(io::Cursor::new(b"1.f3! e5$71 2.g4?? Qh4#!?"));
        reader.read_game(&mut collector)?;
        assert_eq!(
            collector.nags,
            vec![Nag::GOOD_MOVE, Nag(71), Nag::BLUNDER, Nag::SPECULATIVE_MOVE]
        );
        Ok(())
    }

    #[test]
    fn test_null_moves() -> Result<(), io::Error> {
        struct SanCollector {
            sans: Vec<San>,
        }

        impl Visitor for SanCollector {
            type Result = ();

            fn san(&mut self, san: SanPlus) {
                self.sans.push(san.san);
            }

            fn end_game(&mut self) {}
        }

        let mut collector = SanCollector { sans: Vec::new() };
        let mut reader = BufferedReader::new(io::Cursor::new(b"1. e4 -- 2. Nf3 -- 3. -- e5"));
        reader.read_game(&mut collector)?;
        assert_eq!(collector.sans.len(), 6);
        assert_ne!(collector.sans[0], San::Null);
        assert_eq!(collector.sans[1], San::Null);
        assert_ne!(collector.sans[2], San::Null);
        assert_eq!(collector.sans[3], San::Null);
        assert_eq!(collector.sans[4], San::Null);
        assert_ne!(collector.sans[5], San::Null);
        Ok(())
    }

    #[derive(Clone, Copy, Debug)]
    enum MovetextMode {
        Read,
        SkipMovetext,
        SkipVariation,
    }

    struct MovetextProbe {
        mode: MovetextMode,
        event: Vec<u8>,
        sans: usize,
    }

    impl Visitor for MovetextProbe {
        type Result = (Vec<u8>, usize);

        fn header(&mut self, key: &[u8], value: RawHeader<'_>) {
            if key == b"Event" {
                self.event = value.as_bytes().to_vec();
            }
        }

        fn end_headers(&mut self) -> Skip {
            Skip(matches!(self.mode, MovetextMode::SkipMovetext))
        }

        fn begin_variation(&mut self) -> Skip {
            Skip(matches!(self.mode, MovetextMode::SkipVariation))
        }

        fn san(&mut self, _san: SanPlus) {
            self.sans += 1;
        }

        fn end_game(&mut self) -> Self::Result {
            (
                std::mem::take(&mut self.event),
                std::mem::take(&mut self.sans),
            )
        }
    }

    fn parse_movetext_games(
        pgn: &str,
        mode: MovetextMode,
    ) -> Result<Vec<(Vec<u8>, usize)>, io::Error> {
        let mut reader = BufferedReader::new(io::Cursor::new(pgn.as_bytes()));
        let mut visitor = MovetextProbe {
            mode,
            event: Vec::new(),
            sans: 0,
        };
        let mut games = Vec::new();
        while let Some(game) = reader.read_game(&mut visitor)? {
            games.push(game);
        }
        Ok(games)
    }

    fn assert_movetext_games(
        pgn: &str,
        expected_events: &[&[u8]],
        expected_sans: &[usize],
    ) -> Result<(), io::Error> {
        let crlf = pgn.replace('\n', "\r\n");
        for text in [pgn, crlf.as_str()] {
            for mode in [
                MovetextMode::Read,
                MovetextMode::SkipMovetext,
                MovetextMode::SkipVariation,
            ] {
                let games = parse_movetext_games(text, mode)?;
                let events: Vec<&[u8]> = games.iter().map(|(event, _)| event.as_slice()).collect();
                assert_eq!(
                    events, expected_events,
                    "mode={mode:?}, pgn={text:?}, games={games:?}"
                );
                if matches!(mode, MovetextMode::Read) {
                    let sans: Vec<usize> = games.iter().map(|(_, count)| *count).collect();
                    assert_eq!(
                        sans, expected_sans,
                        "mode={mode:?}, pgn={text:?}, games={games:?}"
                    );
                }
            }
        }
        Ok(())
    }

    #[test]
    fn test_blank_line_before_termination_is_not_a_boundary() -> Result<(), io::Error> {
        assert_movetext_games("[Event \"A\"]\n\n1. e4 e5\n\n2. Nf3 Nc6 *", &[b"A"], &[4])?;
        assert_movetext_games("[Event \"A\"]\n\n{intro}\n\n1. e4 *", &[b"A"], &[1])?;
        Ok(())
    }

    #[test]
    fn test_star_inside_variation_then_blank_is_not_a_boundary() -> Result<(), io::Error> {
        assert_movetext_games("1. e4 (1. d4 *\n\n2. Nc3) 2. Nf3 *", &[b""], &[4])?;
        Ok(())
    }

    #[test]
    fn test_blank_line_inside_variation_does_not_end_variation() -> Result<(), io::Error> {
        assert_movetext_games("1. e4 (1. d4\n\n2. Nc3) *", &[b""], &[3])?;
        Ok(())
    }

    #[test]
    fn test_top_level_termination_then_blank_is_a_boundary() -> Result<(), io::Error> {
        for marker in ["1-0", "0-1", "1/2-1/2", "*"] {
            assert_movetext_games(&format!("1. e4 {marker}\n\n1. d4 *"), &[b"", b""], &[1, 1])?;
        }
        Ok(())
    }

    #[test]
    fn test_unclosed_variation_leaves_next_tagged_game() -> Result<(), io::Error> {
        assert_movetext_games(
            "1. e4 (1. d4\n[Event \"B\"]\n\n1. d4 *",
            &[b"", b"B"],
            &[2, 1],
        )?;
        Ok(())
    }
}
