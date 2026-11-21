// Fast drop-in replacement for csv-reader 1.0.0 (make.fun).
// run(input) returns exactly what csv-reader 1.0.0's readCsv returns for
// {text, header}: {columns, rows, errors} — same fields, same error records
// ({code, line, row} plus fields/extra on short_row/long_row), same order.
//
// Design: a single hand-written pass, left to right, with no intermediate
// representation. The hot path takes whole fields with slice (V8 sliced
// strings: O(1), no copy) and finds delimiters with a tight charCodeAt loop;
// the rare broken cases (stray CR, doubled quotes, CR/LF inside quotes,
// quote junk, unterminated quote) fall back to careful re-scans that
// reproduce the reference's semantics exactly, including error order and
// the line/row bookkeeping.
//
// Field-end codes: 0 = comma, 1 = line break, 2 = end of text.

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  outer: while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended = 0; // 0 comma, 1 line break, 2 end
    let lastQuoted = false;

    do {
      let value;
      let junk = false; // this field's unquoted scan is junk after a closing quote
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        const open = pos;
        const openLine = line;
        // Find the closing quote: the next quote that is not doubled.
        let q = pos + 1;
        let closedAt = -1;
        let doubled = false;
        while (true) {
          q = text.indexOf('"', q);
          if (q < 0) break;
          if (text.charCodeAt(q + 1) === 34) {
            doubled = true;
            q += 2;
            continue;
          }
          closedAt = q;
          break;
        }
        if (closedAt < 0) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          line = openLine;
          value = '"';
          // fall through to the unquoted scan below
        } else if (
          !doubled &&
          (text.indexOf('\n', open + 1) < 0 || text.indexOf('\n', open + 1) >= closedAt) &&
          (text.indexOf('\r', open + 1) < 0 || text.indexOf('\r', open + 1) >= closedAt)
        ) {
          // No doubled quote and no line break inside the quotes: the
          // content is one slice.
          value = text.slice(open + 1, closedAt);
          pos = closedAt + 1;
          if (pos >= n) {
            fields.push(value);
            ended = 2;
            continue;
          }
          const c = text.charCodeAt(pos);
          if (c === 44) {
            pos += 1;
            fields.push(value);
            ended = 0;
            continue;
          }
          if (c === 10) {
            pos += 1;
            line += 1;
            fields.push(value);
            ended = 1;
            continue;
          }
          if (c === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            fields.push(value);
            ended = 1;
            continue;
          }
          // What follows the closing quote is appended as it stands, up to
          // the next comma or line break.
          junk = true;
          // fall through to the unquoted scan below, with value as its base
        } else {
          // Line break(s) inside the quotes: re-scan the content, turning
          // each CRLF or lone CR into one LF and each "" into one quote.
          const parts = [];
          let seg = open + 1;
          let i = open + 1;
          while (i < closedAt) {
            const c = text.charCodeAt(i);
            if (c === 34) {
              // Doubled quote (the closing quote is at closedAt, so a quote
              // here is always the first of a pair).
              parts.push(text.slice(seg, i));
              parts.push('"');
              i += 2;
              seg = i;
            } else if (c === 13) {
              parts.push(text.slice(seg, i));
              parts.push('\n');
              line += 1;
              i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
              seg = i;
            } else if (c === 10) {
              line += 1;
              i += 1;
            } else {
              i += 1;
            }
          }
          parts.push(text.slice(seg, closedAt));
          value = parts.join('');
          pos = closedAt + 1;
          if (pos >= n) {
            fields.push(value);
            ended = 2;
            continue;
          }
          const c = text.charCodeAt(pos);
          if (c === 44) {
            pos += 1;
            fields.push(value);
            ended = 0;
            continue;
          }
          if (c === 10) {
            pos += 1;
            line += 1;
            fields.push(value);
            ended = 1;
            continue;
          }
          if (c === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            fields.push(value);
            ended = 1;
            continue;
          }
          junk = true;
          // fall through to the unquoted scan below, with value as its base
        }
      } else {
        lastQuoted = false;
        value = '';
        // fall through to the unquoted scan below
      }

      // ---- Unquoted scan from pos, appending onto `value`. ----
      // A CR not followed by LF is dropped (stray_cr) and the field goes on;
      // a comma ends it, LF or CRLF ends the record, EOF ends the text.
      // `added` counts the characters appended here (junk reporting only).
      let added = 0;
      let seg = null; // segments kept when stray CRs split the field
      let start = pos;
      let i = pos;
      let done = false;
      while (!done) {
        while (i < n) {
          const c = text.charCodeAt(i);
          if (c === 44 || c === 10) break;
          if (c === 13) break;
          i += 1;
        }
        if (i >= n) {
          if (i > start) {
            if (seg === null) value = value === '' ? text.slice(start, i) : value + text.slice(start, i);
            else seg.push(text.slice(start, i));
            added += i - start;
          }
          if (seg !== null) value = value === '' ? seg.join('') : value + seg.join('');
          pos = n;
          ended = 2;
          done = true;
        } else {
          const c = text.charCodeAt(i);
          if (c === 44) {
            if (i > start) {
              if (seg === null) value = value === '' ? text.slice(start, i) : value + text.slice(start, i);
              else seg.push(text.slice(start, i));
              added += i - start;
            }
            if (seg !== null) value = value === '' ? seg.join('') : value + seg.join('');
            pos = i + 1;
            ended = 0;
            done = true;
          } else if (c === 10) {
            if (i > start) {
              if (seg === null) value = value === '' ? text.slice(start, i) : value + text.slice(start, i);
              else seg.push(text.slice(start, i));
              added += i - start;
            }
            if (seg !== null) value = value === '' ? seg.join('') : value + seg.join('');
            pos = i + 1;
            line += 1;
            ended = 1;
            done = true;
          } else if (text.charCodeAt(i + 1) === 10) {
            // CRLF ends the record.
            if (i > start) {
              if (seg === null) value = value === '' ? text.slice(start, i) : value + text.slice(start, i);
              else seg.push(text.slice(start, i));
              added += i - start;
            }
            if (seg !== null) value = value === '' ? seg.join('') : value + seg.join('');
            pos = i + 2;
            line += 1;
            ended = 1;
            done = true;
          } else {
            // Stray CR: dropped, the field goes on.
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            if (seg === null) seg = [];
            if (i > start) seg.push(text.slice(start, i));
            added += i - start;
            i += 1;
            start = i;
          }
        }
      }
      if (junk && added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      fields.push(value);
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue outer;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue outer;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? columns ?? [] : null, rows, errors };
}
