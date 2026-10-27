; coAuthor installer, issue #61.
;
; Tauri includes this hook file near the top of the custom template (installer.nsi). Its only job
; is to tell the template where the page art lives: ${__FILEDIR__} is this file's own directory,
; so the bitmaps next to it are found wherever Tauri renders the template.
!define OB_DIR "${__FILEDIR__}"
