# Pinned Web fonts

- NanumSquare Regular is the original NanumSquare product (not Round or Neo), extracted unchanged from [NAVER’s official ZIP](https://hangeul.naver.com/hangeul_static/webfont/zips/nanum-square.zip). Its internal version is `1.000; 160623_01`. `../font.json` records both archive and TTF SHA-256 values.
- The primary font covers every English and Korean character in the reviewed translations. It lacks 23 Japanese translation characters, so the existing checksum-pinned Noto Sans CJK KR fallback remains bundled.
- Both font files are local build inputs. No font CDN is contacted during build or browser play. The build verifies their hashes before import; tests and export use the same theme and fallback resources.
- Keep `../FONT-LICENSE.txt` with the runtime. NAVER [permits bundling and redistribution with its copyright notice and OFL 1.1](https://help.naver.com/service/30016/contents/18088?osType=PC&lang=ko). Neither font is sold separately or modified.

## Verification contract

The upstream UI specification requires 16 logical units and one line at a 390-unit viewport; narrower logical viewports may wrap. CSS width differs: the responsive shell expands 390×664 CSS pixels to roughly 446 logical units, while 390×760 and tall portrait views can retain a 390-unit viewport.

Native macOS can resolve Helvetica Neue even with the Web theme loaded. Giving macOS the identical Web FontFile reproduces the former Linux wrapping failures. The source suite runs with isolated Fontconfig and the exact bundled files. Compiled-PCK regression disables host font discovery where supported and explicitly loads the PCK’s Web FontFile chain for caption measurements on every host, checks NanumSquare plus Noto fallback identity, and inspects actual logical viewport, line count, clipping, Play reachability and stable preview bounds. Browser checks cover real responsive viewport changes.

NanumSquare resolves Korean wrapping at the original margins. Japanese needs up to 350 logical units with the retained fallback, so only Japanese mode-selection margins change. Fractional Undo/Pause touch widths round upward to remove nested-container centering drift without reducing touch targets. Original source tests and assertions remain unchanged.
