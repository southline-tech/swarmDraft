; coAuthor installer pages (ob1 to ob3), issue #61.
;
; Tauri includes this file (bundle.windows.nsis.installerHooks) right after MUI2.nsh and before
; any page macro, so the MUI_* defines below are picked up by the stock Tauri pages without
; forking the whole installer template. Each MUI page macro consumes and undefines its own
; defines, so a define here only affects the page it names.
;
;   ob1 Welcome  -> MUI_PAGE_WELCOME   (sidebar bitmap, title, one paragraph)
;   ob2 Progress -> MUI_PAGE_INSTFILES (progress bar; file log hidden)
;   ob3 Finish   -> MUI_PAGE_FINISH    ("coAuthor is ready", "Open coAuthor now" checked)

; ---- ob1: Welcome --------------------------------------------------------------------------
!define MUI_WELCOMEPAGE_TITLE "Welcome to coAuthor"
!define MUI_WELCOMEPAGE_TEXT "This will put coAuthor on your computer. It takes about a minute, and you don't need to change anything.$\r$\n$\r$\nClick Next to continue."

; ---- ob2: Progress -------------------------------------------------------------------------
; The mockup shows only the bar, so the scrolling file log starts hidden ("Show details" stays).
ShowInstDetails hide
!define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "coAuthor is installed"
!define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "Click Next to finish."
!define MUI_INSTFILESPAGE_ABORTHEADER_TEXT "coAuthor wasn't installed"
!define MUI_INSTFILESPAGE_ABORTHEADER_SUBTEXT "Nothing on your computer was changed. You can run the installer again."

; ---- ob3: Finish ---------------------------------------------------------------------------
!define MUI_FINISHPAGE_TITLE "coAuthor is ready"
!define MUI_FINISHPAGE_TEXT "You'll find it in your Start menu and on your desktop."
!define MUI_FINISHPAGE_RUN_TEXT "Open coAuthor now"
; MUI_FINISHPAGE_RUN is checked by default (no MUI_FINISHPAGE_RUN_NOTCHECKED), as in ob3.
