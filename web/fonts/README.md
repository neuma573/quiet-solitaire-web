# Pinned Web fonts

- NanumSquare Regular is the original NanumSquare product (not Round or Neo), extracted unchanged from [NAVER’s official ZIP](https://hangeul.naver.com/hangeul_static/webfont/zips/nanum-square.zip). Its internal version is `1.000; 160623_01`. `../font.json` records both archive and TTF SHA-256 values.
- NanumSquare's character map advertises some Japanese characters whose glyph outlines are empty. In the reviewed Japanese translations, 170 of 328 unique characters are missing or empty (23 missing mappings and 147 empty outlines). The Japanese language label also needs fallback in English and Korean menus. The checksum-pinned Noto Sans CJK KR renders Han, Hiragana and Katakana; Latin and Hangul retain NanumSquare.
- Both font files are local build inputs. No font CDN is contacted during build or browser play. The build verifies their hashes before import and exports the prepared theme and fallback resources.
- Keep `../FONT-LICENSE.txt` with the runtime. NAVER [permits bundling and redistribution with its copyright notice and OFL 1.1](https://help.naver.com/service/30016/contents/18088?osType=PC&lang=ko). Neither font is sold separately or modified.

## Rendering design and historical verification

The upstream UI specification requires 16 logical units and one line at a 390-unit viewport; narrower logical viewports may wrap. CSS width differs: the responsive shell expands 390×664 CSS pixels to roughly 446 logical units, while 390×760 and tall portrait views can retain a 390-unit viewport.

Earlier font verification found that native macOS can resolve Helvetica Neue even with the Web theme loaded. The build uses an empty Fontconfig directory and processed FontFile resources so raw TTF discovery cannot bypass their script settings. Earlier compiled-PCK and browser checks covered shaped glyphs, fallback selection, clipping and viewport behavior; these checks are not current Web CI requirements.

Godot always tries the base font before considering fallback script priorities. The theme therefore uses an empty routing anchor, with unmodified NanumSquare and Noto font bytes in processed fallback resources. NanumSquare marks Han, Hiragana, Katakana and Japanese as unsupported; system fallback is disabled. This routes even mapped-but-empty Japanese glyphs to Noto without altering either font file.

NanumSquare resolves Korean wrapping at the original margins. With correct Japanese fallback, the longest Japanese caption needs 344 logical units, so only Japanese mode-selection side margins change from 24 to 23. Fractional Undo/Pause touch widths round upward to remove nested-container centering drift without reducing touch targets. The private source tests and assertions are not modified or rerun by the Web build.
