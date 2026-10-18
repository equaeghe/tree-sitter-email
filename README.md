# tree-sitter-email

A [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) grammar for
RFC 5322 email messages / MIME (`.eml`) files, written to back a Zed syntax
highlighting extension.

It isn't a novel design: the *scope* of what gets parsed out — which header
fields get "structured" treatment, how MIME parts and quoting are detected,
what counts as a signature — is deliberately modeled on two long-standing
editor syntax definitions, so that highlighting in Zed feels familiar to
anyone coming from Vim or Kate/KDE apps:

- Vim's `runtime/syntax/mail.vim`
- KDE's [KSyntaxHighlighting `data/syntax/email.xml`](https://github.com/KDE/syntax-highlighting)

## Node reference and where each idea came from

| Node | Meaning | Modeled on |
|---|---|---|
| `header` / `header_name` / `header_value` | One `Name: value` header, with RFC 5322 folding (continuation lines) | Vim's `mailHeader`/`mailHeaderKey`; Kate's `header` context |
| `quoted_string`, `comment`, `address`, `escaped_char` | Substructure inside *known* header values (`From`, `To`, `Date`, `Content-Type`, ...) | Kate's `header-structured-content`, `string-context`, `comment-context`, `quoted-pair` |
| Subject's `header_value` | Deliberately plain/unstructured (see "Known limitation" below) | Kate's `header-subject` context, which also only special-cases quoted strings |
| `mime_boundary` / `mime_part` | A `--boundary` line, after which header parsing restarts | Kate's `body-context`, which pops back into header parsing on a boundary-shaped line |
| `quoted_line` / `quote_marker` / `quote_content` | A `>`-quoted reply line | Vim's `mailQuoted1-6` / `mailQuoteExp1-6` |
| `signature` / `signature_marker` / `signature_line` | A `-- ` signature block running to EOF/blank line | Vim's `mailSignature` |
| `verbatim` / `verbatim_marker` / `verbatim_line` | A `#v+` / `#v-` literal block | Vim's `mailVerbatim` |
| `url`, `email` (inline, in body/signature/quotes) | Autolinked URLs and bare addresses | Vim's `mailURL` / `mailEmail`, `contains=@mailLinks` |
| `envelope_line` | An mbox `From sender date` separator | Vim's mbox handling |

## Deliberate simplifications

- **Quote depth.** Vim alternates six colors across nested `>` quote levels
  (`mailQuoted1`...`mailQuoted6`). This grammar collapses that to a single
  depth-agnostic `quoted_line` node (with the marker and the quoted text
  still captured separately, so a theme *could* still style them
  differently). This matches Kate, which has no quote-depth handling at
  all.
- **MIME boundaries are detected heuristically**, not by tracking the
  actual `boundary=` parameter from the enclosing `Content-Type` header.
  Matching a specific dynamic boundary string is a context-sensitive
  problem (the same class as heredocs), and Kate itself makes the exact
  same simplification: both use a generic "looks like `--something`"
  shape check rather than semantic analysis.
- **Known vs. unknown headers.** Only a fixed list of common header names
  (`From`, `To`, `Cc`, `Date`, `Content-Type`, `DKIM-Signature`, ...,
  ported from Kate's header-names keyword list) get address/comment/quote
  parsing inside their value. Anything else (most `X-*` headers) is
  highlighted as a header but its value is left as plain folded text —
  exactly Kate's "Common Header" vs. "Other Header" split.

## Known limitation

Inside a `Subject:` header specifically, an embedded quoted string (e.g.
`Subject: Re: "Quarterly Report"`) is *not* parsed out into its own
`quoted_string` node the way it is for other structured headers or the
way Kate's `header-subject` context does it. The whole value is left as
flat text instead. This was a genuine bit of trouble to track down: it
traces back to a parser-state-reachability quirk in tree-sitter's LALR
table construction that appears specifically when `_subject_value`'s
repeat construct is the *sole* alternative reachable from that state
(isolating it down to just the `Subject` rule reproduces the failure even
for a trivial value; adding the sibling header-value rules back changes
the parse tables enough that plain values parse fine again, but the
embedded-quote case still degrades to flat text rather than erroring).
Critically, this degrades *safely* -- it never produces an `ERROR` node,
it just doesn't highlight the quotes specially. If you can get to the
bottom of it, a PR (or better regex-free restructuring of the subject
value rule) is very welcome.

Two other, more subtle tree-sitter behaviors worth knowing if you extend
this grammar:

- `{n,}`-style open-ended regex quantifiers (e.g. `/--[!-~]{6,}(--)?/`)
  hit a compiler quirk in this tree-sitter version where the match gets
  truncated well short of what the equivalent JS regex would match.
  Rewriting as `{n,}` → `+` (with the minimum-length check dropped or
  moved elsewhere) reliably works around it. See the `mime_boundary` and
  `email` token definitions.
- Tree-sitter's lexer resolves competing token matches by **longest match
  first, with declared `prec()` only breaking ties of equal length** --
  it does not let precedence override a genuinely longer match. This
  matters a lot for a generic "any non-space run" fallback token
  competing with more specific tokens like `url`/`email`: if the fallback
  is allowed to swallow trailing punctuation (`me@example.com.`), it
  becomes longer than the specific match and wins outright, regardless of
  precedence. The fix here was to exclude common trailing punctuation
  from the fallback token's character class so it can't out-run the
  specific tokens by absorbing a trailing `.`/`,`/etc.

## Building

```sh
npm install
npx tree-sitter generate
npx tree-sitter build
npx tree-sitter test
```

`test/corpus/*.txt` has a small regression suite; `examples/*.eml` has a
few hand-written sample messages (plain, multipart MIME, verbatim,
CRLF/edge cases, no-trailing-newline) used while developing the grammar.

## License

MIT
