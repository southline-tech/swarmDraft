# PR evidence — #159 spell / grammar

Designer frames (issue comment): sc1–sc6 light + dark.

| File                        | Frame                              |
| --------------------------- | ---------------------------------- |
| sc1-underlines-light.png    | sc1 underlines (light)             |
| sc1-underlines-dark.png     | sc1 underlines (`data-theme=dark`) |
| sc2-spelling-menu-light.png | sc2 spelling menu                  |
| sc2-spelling-menu-dark.png  | sc2 spelling menu (dark)           |
| sc3-grammar-menu-light.png  | sc3 grammar menu                   |
| sc3-grammar-menu-dark.png   | sc3 grammar menu (dark)            |
| sc4-dictionary-light.png    | sc4 dictionary + toggles           |
| sc4-dictionary-dark.png     | sc4 dictionary (dark)              |
| sc5-empty-dict-light.png    | sc5 empty dictionary               |
| sc5-empty-dict-dark.png     | sc5 empty dictionary (dark)        |
| sc6-dict-search-light.png   | sc6 dictionary search              |
| sc6-dict-search-dark.png    | sc6 dictionary search (dark)       |

Capture from `docs/pr-evidence/159/evidence.html` (matches production tokens and shell menu styles):

```sh
cd docs/pr-evidence/159 && chmod +x capture.sh && ./capture.sh
```

Or manually with Chrome:

```sh
google-chrome --headless=new --window-size=800,450 \
  --screenshot=docs/pr-evidence/159/sc1-underlines-light.png \
  'file://'"$PWD"'/docs/pr-evidence/159/evidence.html?scene=sc1'
```

Toggle `&theme=dark` on the URL for dark shots (`data-theme="dark"`).
