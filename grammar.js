// tree-sitter-email
//
// A Tree-sitter grammar for RFC 5322 email messages / MIME (.eml) files.
//
// This grammar's *scope* (which header fields get "structured" parsing vs.
// plain text, the MIME-boundary heuristic, the header/body state machine)
// is deliberately modeled on two long-standing editor syntax definitions:
//
//   - Vim's runtime/syntax/mail.vim (mailHeader, mailHeaderKey, mailSubject,
//     mailSignature, mailQuoted1-6, mailQuoteExp1-6, mailURL, mailEmail,
//     mailVerbatim groups)
//   - KDE's KSyntaxHighlighting data/syntax/email.xml (the "header",
//     "header-subject", "header-structured-content", "header-content",
//     "string-context", "comment-context", "quoted-pair", "body-context"
//     contexts, and its header-names keyword list)
//
// See README.md for a group-by-group mapping back to those two sources.

// ---------------------------------------------------------------------
// Build a case-insensitive regex from a literal string, e.g. "From" ->
// /[Ff][Rr][Oo][Mm]/. Field names in email headers are case-insensitive
// per RFC 5322 ("Field names ... are not case sensitive").
// ---------------------------------------------------------------------
function ciChar(c) {
  if (/[a-zA-Z]/.test(c)) {
    return `[${c.toLowerCase()}${c.toUpperCase()}]`;
  }
  return c.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}
function ci(str) {
  return str.split('').map(ciChar).join('');
}

// The "known" / "common" header names that get full structured-value
// parsing (addresses, quoted strings, parenthetical comments). Anything
// not in this list still gets recognized as a header, but its value is
// treated as plain (folded) text -- this mirrors Kate's split between its
// "header-names" keyword list (-> "Common Header" / structured content)
// and its generic `^[0-9a-zA-Z-]+:\s` fallback (-> "Other Header" / plain
// content), and Vim's distinction between the fixed header-keyword
// alternation in mailHeaderKey and everything else just being part of the
// mailHeader region.
const COMMON_HEADER_NAMES = [
  'Authentication-Results', 'Bcc', 'Cc', 'Comments', 'Content-Description',
  'Content-Disposition', 'Content-Transfer-Encoding', 'Content-Type',
  'Date', 'Delivered-To', 'DKIM-Signature', 'Errors-To', 'From',
  'In-Reply-To', 'Keywords', 'Lines', 'Message-Id', 'List-Archive',
  'List-Id', 'List-Help', 'List-Post', 'List-Unsubscribe', 'List-Subscribe',
  'MIME-Version', 'Newsgroups', 'Organization', 'Precedence', 'Received',
  'Received-SPF', 'References', 'Replied', 'Reply-To', 'Resent-Bcc',
  'Resent-Cc', 'Resent-Date', 'Resent-From', 'Resent-Message-Id',
  'Resent-Reply-To', 'Resent-Sender', 'Resent-To', 'Return-Path',
  'Sender', 'Supersedes', 'To', 'User-Agent', 'Xref', 'X-Mailer',
  'X-Priority', 'Followup-To', 'Control',
];

const commonHeaderPattern = new RegExp(
  COMMON_HEADER_NAMES
    // Longer names first, so e.g. "Resent-Message-Id" is tried before "Message-Id"
    // would matter if we did prefix matching; we anchor to `:` so it isn't
    // strictly necessary, but it's cheap insurance.
    .sort((a, b) => b.length - a.length)
    .map(ci)
    .join('|')
);

module.exports = grammar({
  name: 'email',

  // This grammar is intentionally line-oriented: newlines and header
  // folding (continuation lines starting with a space/tab) are meaningful,
  // so we do NOT let tree-sitter skip whitespace/newlines automatically.
  extras: $ => [],

  word: $ => $._word,

  conflicts: $ => [],

  rules: {
    // A message: optional mbox "From " envelope line, headers, a blank
    // line, and a body (which recognizes MIME-multipart boundaries and
    // starts a fresh set of headers after each one -- see `mime_part`
    // below, so a single `source_file` already covers multipart MIME
    // messages). A bare mbox file containing several concatenated
    // messages will still highlight sensibly: an unrecognized blank-line
    // + header-shaped block partway through a body just reads as a new
    // header run within that same body, which is exactly how Vim's own
    // mail.vim (which has no special mbox-multi-message handling either)
    // behaves.
    source_file: $ => seq(
      optional($.envelope_line),
      repeat($._header_line),
      optional($.body),
    ),

    // mbox "From sender date" separator line. Distinct from a `From:`
    // header. Vim requires a trailing 4-digit year; we relax that slightly.
    envelope_line: $ => seq(
      token(prec(4, /From [^\r\n]*/)),
      $._eol,
    ),

    // ------------------------------------------------------------
    // Headers
    // ------------------------------------------------------------
    _header_line: $ => seq($.header, $._eol),

    header: $ => choice(
      $._subject_header,
      $._structured_header,
      $._other_header,
    ),

    // Subject: only string literals get special treatment inside the
    // value (Kate's header-subject context: quoted strings only, no
    // address/comment parsing). Vim highlights the whole line as
    // mailSubject / Title.
    _subject_header: $ => seq(
      field('name', alias(token(prec(3, seq(ci('Subject'), ':'))), $.header_name)),
      optional(field('value', alias($._subject_value, $.header_value))),
    ),
    _subject_value: $ => repeat1($._subject_piece),
    _subject_piece: $ => choice(
      $.quoted_string,
      $.escaped_char,
      $._subject_text,
      $._fold,
    ),
    // Subject has no comment/address sub-rules, so unlike the structured
    // value there's no need to carve '(' ')' '<' '>' out of the plain
    // text token -- they can just be ordinary characters here, same as
    // Kate's header-subject context (quoted strings only, everything
    // else is plain text).
    _subject_text: $ => token(prec(-1, /[^"\\\r\n]+/)),

    // Known headers (From, To, Cc, Date, Content-Type, ...): structured
    // value with addresses, quoted strings and parenthetical comments.
    _structured_header: $ => seq(
      field('name', alias(token(prec(2, seq(commonHeaderPattern, ':'))), $.header_name)),
      optional(field('value', alias($._structured_value, $.header_value))),
    ),
    _structured_value: $ => repeat1($._structured_piece),
    _structured_piece: $ => choice(
      $.quoted_string,
      $.comment,
      $.address,
      $.escaped_char,
      $._value_text,
      $._fold,
      $._stray_char,
    ),

    // Any other "Word-Chars:" line is still recognized as a header, but
    // its value is left as plain folded text (Kate's "Other Header" /
    // header-content context).
    _other_header: $ => seq(
      // RFC 5322 allows any printable ASCII except ':' in a field name, and
      // real mail uses underscores and dots (e.g. Outlook's `msip_labels:`).
      // A name the grammar rejects doesn't just lose its own colour: the
      // parser leaves the header block and treats every later line as body.
      field('name', alias(token(prec(1, /[A-Za-z_][A-Za-z0-9_.-]*:/)), $.header_name)),
      optional(field('value', alias($._other_value, $.header_value))),
    ),
    _other_value: $ => repeat1($._other_piece),
    _other_piece: $ => choice(
      $._value_text,
      $._fold,
      $._stray_char,
    ),

    // Plain run of header-value text, deliberately low precedence so the
    // more specific pieces above (quoted string, comment, address...) win
    // where they apply.
    _value_text: $ => token(prec(-1, /[^"()<>\\\r\n]+/)),
    // A single "stray" special character that didn't start a valid
    // quoted-string / comment / address (e.g. a lone '<'), so the parser
    // doesn't get stuck.
    _stray_char: $ => token(prec(-2, /["()<>\\]/)),
    // A folded continuation: newline immediately followed by required
    // leading whitespace, per RFC 5322 header folding. Must outrank the
    // plain `_eol` token (which ends the header's own line) whenever a
    // continuation is actually present.
    _fold: $ => token(prec(5, /\r?\n[ \t]+/)),

    quoted_string: $ => prec.right(seq(
      '"',
      repeat(choice($.escaped_char, $._fold, token(prec(-1, /[^"\\\r\n]+/)))),
      optional('"'),
    )),

    // Parenthetical comments, RFC 5322 style, may nest.
    // `_fold` is allowed inside comments and quoted strings so a node that
    // wraps onto a continuation line (very common in `Received:`) keeps its
    // span, and therefore its highlighting, across the line break.
    comment: $ => prec.right(seq(
      '(',
      repeat(choice($.comment, $.escaped_char, $._fold, token(prec(3, /[^()\\\r\n]+/)))),
      optional(')'),
    )),

    escaped_char: $ => token(prec(2, /\\[\x00-\x7f]/)),

    // `<user@host>` or a bare `user@host`.
    address: $ => token(prec(1, /<?[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+>?/)),

    // ------------------------------------------------------------
    // Body
    // ------------------------------------------------------------
    body: $ => prec.right(repeat1($._body_element)),

    _body_element: $ => choice(
      $.mime_part,
      $.verbatim,
      $.signature,
      $.quoted_line,
      $.plain_line,
      alias($._eol, $.blank_line),
    ),

    // A MIME multipart boundary line, optionally followed immediately by
    // that part's own headers -- mirrors Kate's body-context, which on
    // seeing a boundary-shaped line (`^--[0-9a-zA-Z._=-]{10,}(--)?$`) pops
    // back into header parsing. We use the same generic shape heuristic
    // rather than tracking the real `boundary=` parameter, since these
    // are dynamic per-message and matching them exactly needs semantic
    // (not syntactic) analysis -- same simplification Kate itself makes.
    mime_part: $ => prec.right(seq(
      $.mime_boundary,
      repeat($._header_line),
    )),

    mime_boundary: $ => seq(
      token(prec(3, /--[!-~]+/)),
      $._eol,
    ),

    // Vim's "#v+ ... #v-" verbatim convention: content that should never
    // be treated as quoted/signature/etc.
    verbatim: $ => seq(
      field('marker', alias(token(prec(4, '#v+')), $.verbatim_marker)),
      $._eol,
      optional($._verbatim_lines),
      optional(seq(
        field('marker', alias(token(prec(4, '#v-')), $.verbatim_marker)),
        $._eol,
      )),
    ),
    // Explicit right recursion (rather than `repeat`) so `prec.right` can
    // actually bias the parser toward consuming another raw line instead
    // of popping back out to let quoted_line/plain_line reinterpret the
    // same text -- `repeat()` doesn't expose that knob the same way.
    _verbatim_lines: $ => prec.right(seq($.verbatim_line, optional($._verbatim_lines))),
    verbatim_line: $ => seq(
      token(prec(3, /[^\r\n]+/)),
      $._eol,
    ),

    // "-- " on its own line starts a signature block that runs to the
    // next blank line (or EOF) -- Vim's mailSignature region.
    signature: $ => prec.right(seq(
      field('marker', alias(token(prec(2, '-- ')), $.signature_marker)),
      $._eol,
      repeat($.signature_line),
    )),
    signature_line: $ => seq(
      repeat1($._text_fragment),
      $._eol,
    ),

    // A line quoted with leading '>' markers (reply quoting). We collapse
    // Vim's six alternating quote-depth colors (mailQuoted1-6 /
    // mailQuoteExp1-6) into a single depth-agnostic quote scope, which is
    // how most modern editors (and Kate, which has no quote-depth
    // handling at all) treat it; the marker and the quoted text are still
    // captured separately so a theme *could* style them differently.
    quoted_line: $ => seq(
      field('marker', alias(token(prec(2, /(>[ \t]?)+/)), $.quote_marker)),
      optional(field('content', alias($._quoted_content, $.quote_content))),
      $._eol,
    ),
    _quoted_content: $ => repeat1($._text_fragment),

    plain_line: $ => seq(
      repeat1($._text_fragment),
      $._eol,
    ),

    // Shared body text tokenizer: recognize URLs and bare e-mail
    // addresses inline (Vim's mailURL / mailEmail, `contains=@mailLinks`
    // in the body, quotes and signature), falling back to generic words.
    _text_fragment: $ => choice(
      $.url,
      $.email,
      token(prec(-1, /[ \t]+/)),
      // Trailing sentence punctuation is deliberately excluded from the
      // generic word token: since tree-sitter's lexer picks the longest
      // match first and only falls back to precedence as a tie-breaker,
      // letting this token swallow a trailing '.'/',' etc. would make it
      // outrun (and always win over) a shorter `url`/`email` match ending
      // right before that punctuation -- e.g. "me@example.com." would
      // otherwise never be recognized as an email. Punctuation characters
      // just end up as their own low-precedence single-char token instead.
      token(prec(-2, /[^\s.,;:!?()<>\[\]{}'"\r\n]+/)),
      token(prec(-3, /[.,;:!?()<>\[\]{}'"]/)),
    ),

    url: $ => token(prec(2, /(https?|ftp|gopher):\/\/[^\s'"<>]+|(www|web|w3)[a-zA-Z0-9_-]*\.[a-zA-Z0-9._-]+\.[^\s'"<>]+/)),
    email: $ => token(prec(2, /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]+/)),

    _eol: $ => /\r?\n/,
    _word: $ => /[A-Za-z][A-Za-z0-9-]*/,
  },
});
