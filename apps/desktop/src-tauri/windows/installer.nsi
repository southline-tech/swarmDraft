; swarmDraft custom installer template (issue #61).
;
; Copied from the Tauri v2 default installer.nsi (tauri-cli v2.12.4) and changed only where marked
; "swarmDraft:". Pages follow mockups ob1 to ob3: custom nsDialogs welcome and finish pages, no
; install location page for per-user installs, and the progress page copy. Colours are the light
; --ct-* token values. Passive (/P), silent (/S) and update (/UPDATE) paths are unchanged.

Unicode true
ManifestDPIAware true
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
ManifestDPIAwareness PerMonitorV2

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

; Keep above !include to stay ahead of any plugin command
; see https://github.com/tauri-apps/tauri/pull/15422#discussion_r3289239624
{{#if signed_plugins_path}}
!addplugindir "{{signed_plugins_path}}"
{{/if}}

!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "Win\RestartManager.nsh"
!include "StrFunc.nsh"
${StrCase}
${StrLoc}

{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

; swarmDraft: page art and palette. OB_DIR is set by windows/installer-pages.nsh (the hook file).
!ifndef OB_DIR
  !error "swarmDraft: installer-pages.nsh must be set as bundle.windows.nsis.installerHooks"
!endif
!define OB_SURFACE "FFFFFF"    ; --ct-surface
!define OB_BG "F3EFE8"         ; --ct-bg (footer)
!define OB_TEXT "2B2620"       ; --ct-text
!define OB_MUTED "6B6157"      ; --ct-text-muted
!define OB_ACCENT_BGR 0xA85D2F ; --ct-accent #2f5da8 as a Win32 COLORREF
!define OB_BORDER_BGR 0xC9D5DD ; --ct-border #ddd5c9 as a Win32 COLORREF

; swarmDraft: page state shared by the installer and uninstaller pages.
Var ObDialog
Var ObFontTitle
Var ObFontLead
Var ObFontBody
Var ObImage
Var ObRunCheckbox
Var ObRunState
Var ObSwapped

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define UNINSTALLERICON "{{uninstaller_icon}}"
!define UNINSTALLERHEADERIMAGE "{{uninstaller_header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName

Name "${PRODUCTNAME}"
; swarmDraft: window title from the mockups.
Caption "Install ${PRODUCTNAME}"
UninstallCaption "Uninstall ${PRODUCTNAME}"
; swarmDraft: ob2 shows no install log.
ShowInstDetails nevershow
BrandingText "${COPYRIGHT}"
OutFile "${OUTFILE}"

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

# additional plugins
!addplugindir "${ADDITIONALPLUGINSPATH}"

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Handle install mode, `perUser`, `perMachine` or `both`
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!endif

!if "${INSTALLMODE}" == "currentUser"
  RequestExecutionLevel user
!endif

!if "${INSTALLMODE}" == "both"
  !define MULTIUSER_MUI
  !define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCTNAME}"
  !define MULTIUSER_INSTALLMODE_COMMANDLINE
  !if "${ARCH}" == "x64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !else if "${ARCH}" == "arm64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !endif
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
  !define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
  !define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
  !define MULTIUSER_EXECUTIONLEVEL Highest
  !include MultiUser.nsh
!endif

; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
!endif

; Installer sidebar image
!if "${SIDEBARIMAGE}" != ""
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
!endif

; Enable header images for installer and uninstaller pages when either image is configured.
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!else if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!endif

; Installer header image
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_BITMAP "${HEADERIMAGE}"
!endif

; Uninstaller header image
!if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_UNBITMAP "${UNINSTALLERHEADERIMAGE}"
!endif

; Uninstaller icon
!if "${UNINSTALLERICON}" != ""
  !define MUI_UNICON "${UNINSTALLERICON}"
!endif

; Define registry key to store installer language
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

; Installer pages, must be ordered as they appear
; 1. Welcome Page
; swarmDraft: custom nsDialogs page (ob1) instead of MUI_PAGE_WELCOME.
Page custom ObWelcomeCreate ObWelcomeLeave

; 2. License Page (if defined)
!if "${LICENSE}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!endif

; 3. Install mode (if it is set to `both`)
!if "${INSTALLMODE}" == "both"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MULTIUSER_PAGE_INSTALLMODE
!endif

; 4. Custom page to ask user if he wants to reinstall/uninstall
;    only if a previous installation was detected
Var ReinstallPageCheck
Page custom PageReinstall PageLeaveReinstall

; Find a previous WiX installation and set $R6 to its uninstall registry key, or to "" if none.
;
; A WiX installer stores the installation info in registry
; using a UUID and so we have to loop through all keys under
; `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
; and check if `DisplayName` and `Publisher` keys match ${PRODUCTNAME} and ${MANUFACTURER}
;
; This has a potential issue that there maybe another installation that matches
; our ${PRODUCTNAME} and ${MANUFACTURER} but wasn't installed by our WiX installer,
; however, this should be fine since the user will have to confirm the uninstallation
; and they can chose to abort it if doesn't make sense.
Function FindWixInstall
  StrCpy $R6 ""
  StrCpy $0 0
  wix_loop:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" wix_loop_done ; Exit loop if there is no more keys to loop on
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 wix_loop
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 0 0 wix_loop_done
    StrCpy $R6 "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1"
  wix_loop_done:
FunctionEnd

Function PageReinstall
  ; Uninstall previous WiX installation if exists.
  Call FindWixInstall
  ${If} $R6 != ""
    StrCpy $WixMode 1
    Goto compare_version
  ${EndIf}

  ; Check if there is an existing installation, if not, abort the reinstall page
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${IfThen} "$R0$R1" == "" ${|} Abort ${|}

  ; Compare this installar version with the existing installation
  ; and modify the messages presented to the user accordingly
  compare_version:
  StrCpy $R4 "$(older)"
  ${If} $WixMode = 1
    ReadRegStr $R0 HKLM "$R6" "DisplayVersion"
  ${Else}
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}
  ${IfThen} $R0 == "" ${|} StrCpy $R4 "$(unknown)" ${|}

  nsis_tauri_utils::SemverCompare "${VERSION}" $R0
  Pop $R0

  ; Reinstalling the same version
  ${If} $R0 = 0
    StrCpy $R1 "$(alreadyInstalledLong)"
    StrCpy $R2 "$(addOrReinstall)"
    StrCpy $R3 "$(uninstallApp)"
  ; Upgrading
  ${ElseIf} $R0 = 1
    StrCpy $R1 "$(olderOrUnknownVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    StrCpy $R3 "$(dontUninstall)"
  ; Downgrading
  ${ElseIf} $R0 = -1
    StrCpy $R1 "$(newerVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    !if "${ALLOWDOWNGRADES}" == "true"
      StrCpy $R3 "$(dontUninstall)"
    !else
      StrCpy $R3 "$(dontUninstallDowngrade)"
    !endif
  ${Else}
    Abort
  ${EndIf}

  ; Skip showing the page if passive
  ;
  ; Note that we don't call this earlier at the beginning
  ; of this function because we need to populate some variables
  ; related to current installed version if detected and whether
  ; we are downgrading or not.
  ${If} $PassiveMode = 1
    Call PageLeaveReinstall
  ${Else}
    ; swarmDraft: ob1 layout (tile, Literata title, lead, two choices) instead of the stock page.
    InitPluginsDir
    File "/oname=$PLUGINSDIR\ob-logo.bmp" "${OB_DIR}\ob-logo.bmp"
    Call ObFonts
    nsDialogs::Create 1044
    Pop $R4
    ${If} $R4 == error
      Abort
    ${EndIf}
    ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}
    SetCtlColors $R4 "" "${OB_SURFACE}"
    StrCpy $0 "ob-logo.bmp"
    Call ObTile
    ${If} $R0 = 0
      StrCpy $0 "swarmDraft is already installed"
    ${ElseIf} $R0 = 1
      StrCpy $0 "Update swarmDraft"
    ${Else}
      StrCpy $0 "A newer swarmDraft is installed"
    ${EndIf}
    StrCpy $1 $R1
    Call ObTitleLead

    ${NSD_CreateRadioButton} 26u 130u 280u 12u $R2
    Pop $R2
    SetCtlColors $R2 "${OB_TEXT}" "${OB_SURFACE}"
    SendMessage $R2 ${WM_SETFONT} $ObFontBody 1
    ${NSD_OnClick} $R2 PageReinstallUpdateSelection

    ${NSD_CreateRadioButton} 26u 146u 280u 12u $R3
    Pop $R3
    SetCtlColors $R3 "${OB_TEXT}" "${OB_SURFACE}"
    SendMessage $R3 ${WM_SETFONT} $ObFontBody 1
    ; Disable this radio button if downgrading and downgrades are disabled
    !if "${ALLOWDOWNGRADES}" == "false"
      ${IfThen} $R0 = -1 ${|} EnableWindow $R3 0 ${|}
    !endif
    ${NSD_OnClick} $R3 PageReinstallUpdateSelection

    ; Check the first radio button if this the first time
    ; we enter this page or if the second button wasn't
    ; selected the last time we were on this page
    ${If} $ReinstallPageCheck <> 2
      SendMessage $R2 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${Else}
      SendMessage $R3 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${EndIf}

    ${NSD_SetFocus} $R2
    ; Cancel on the left, "Continue" on the right, no Back (same as ob1).
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Continue"
    Call ObSwapButtons
    GetDlgItem $0 $HWNDPARENT 3
    ShowWindow $0 ${SW_HIDE}
    Call ObFullWindow
    nsDialogs::Show
    ${NSD_FreeImage} $ObImage
    Call ObNormalWindow
    GetDlgItem $0 $HWNDPARENT 3
    ShowWindow $0 ${SW_NORMAL}
  ${EndIf}
FunctionEnd
Function PageReinstallUpdateSelection
  ${NSD_GetState} $R2 $R1
  ${If} $R1 == ${BST_CHECKED}
    StrCpy $ReinstallPageCheck 1
  ${Else}
    StrCpy $ReinstallPageCheck 2
  ${EndIf}
FunctionEnd
Function PageLeaveReinstall
  ${NSD_GetState} $R2 $R1

  ; If migrating from Wix, always uninstall
  ${If} $WixMode = 1
    Goto reinst_uninstall
  ${EndIf}

  ; In update mode, always proceeds without uninstalling
  ${If} $UpdateMode = 1
    Goto reinst_done
  ${EndIf}

  ; $R0 holds whether same(0)/upgrading(1)/downgrading(-1) version
  ; $R1 holds the radio buttons state:
  ;   1 => first choice was selected
  ;   0 => second choice was selected
  ${If} $R0 = 0 ; Same version, proceed
    ${If} $R1 = 1              ; User chose to add/reinstall
      Goto reinst_done
    ${Else}                    ; User chose to uninstall
      Goto reinst_uninstall
    ${EndIf}
  ${ElseIf} $R0 = 1 ; Upgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${ElseIf} $R0 = -1 ; Downgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${EndIf}

  reinst_uninstall:
    HideWindow
    ClearErrors

    ${If} $WixMode = 1
      ReadRegStr $R1 HKLM "$R6" "UninstallString"
      ExecWait '$R1' $0
    ${Else}
      ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
      ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
      ${IfThen} $UpdateMode = 1 ${|} StrCpy $R1 "$R1 /UPDATE" ${|} ; append /UPDATE
      ${IfThen} $PassiveMode = 1 ${|} StrCpy $R1 "$R1 /P" ${|} ; append /P
      StrCpy $R1 "$R1 _?=$4" ; append uninstall directory
      ExecWait '$R1' $0
    ${EndIf}

    BringToFront

    ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|} ; ExecWait failed, set fake exit code

    ${If} $0 <> 0
    ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ; User cancelled wix uninstaller? return to select un/reinstall page
      ${If} $WixMode = 1
      ${AndIf} $0 = 1602
        Abort
      ${EndIf}

      ; User cancelled NSIS uninstaller? return to select un/reinstall page
      ${If} $0 = 1
        Abort
      ${EndIf}

      ; Other errors? show generic error message and return to select un/reinstall page
      MessageBox MB_ICONEXCLAMATION "$(unableToUninstall)"
      Abort
    ${EndIf}

    ; The NSIS uninstaller was run in place (`_?=`), so it cannot delete itself
    ; and the install directory, clean them up here once the uninstall succeeded
    ; https://nsis.sourceforge.io/Docs/Chapter3.html#:~:text=path%20contains%20spaces.-,3.2.3%20Examples,-installer.exe%20/NCRC
    ${If} $WixMode = 0
    ${AndIf} $4 != ""
      Delete "$4\uninstall.exe"
      RMDir "$4"
    ${EndIf}
  reinst_done:
FunctionEnd

; 5. Choose install directory page
; swarmDraft: per-user installs always go to %LOCALAPPDATA%\${PRODUCTNAME}, so skip the page.
!if "${INSTALLMODE}" == "currentUser"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!else
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!endif
!insertmacro MUI_PAGE_DIRECTORY

; 6. Start menu shortcut page
Var AppStartMenuFolder
!if "${STARTMENUFOLDER}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !define MUI_STARTMENUPAGE_DEFAULTFOLDER "${STARTMENUFOLDER}"
!else
  !define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!endif
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder

; 7. Installation page
; swarmDraft: the show function turns the stock page into the ob2 layout (full window, Ribbon
; tile, title, line and one progress bar, only Cancel). The header text below is only a fallback.
!define MUI_PAGE_HEADER_TEXT "Installing swarmDraft…"
!define MUI_PAGE_HEADER_SUBTEXT "Almost there. You can keep using your computer while this finishes."
!define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "swarmDraft is installed"
!define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "Click Next to finish."
!define MUI_INSTFILESPAGE_ABORTHEADER_TEXT "swarmDraft wasn't installed"
!define MUI_INSTFILESPAGE_ABORTHEADER_SUBTEXT "Nothing was changed. You can run the installer again."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW ObProgressShow
!insertmacro MUI_PAGE_INSTFILES

; 8. Finish page
; swarmDraft: custom nsDialogs page (ob3) instead of MUI_PAGE_FINISH. "Open swarmDraft now" runs
; RunMainBinary and is ticked by default. The desktop shortcut is always created by the install
; section, so there is no checkbox for it. Skipped in passive mode.
Page custom ObFinishCreate ObFinishLeave


!define /ifndef PBM_SETBARCOLOR 0x0409
!define /ifndef PBM_SETBKCOLOR 0x2001
; swarmDraft: the page helpers are needed by the installer and the uninstaller pages, so they are
; defined twice through this macro (UN = "" or "un.").
!macro OB_HELPERS UN
; Windows 11 ships Segoe UI Variable; Windows 10 has Segoe UI.
Function ${UN}ObFonts
  ${If} $ObFontTitle != ""
    Return
  ${EndIf}
  ; Literata (SIL OFL 1.1, see fonts/Literata-OFL.txt), loaded privately for this process only.
  InitPluginsDir
  File "/oname=$PLUGINSDIR\Literata-Regular.ttf" "${OB_DIR}\fonts\Literata-Regular.ttf"
  System::Call 'gdi32::AddFontResourceEx(t "$PLUGINSDIR\Literata-Regular.ttf", i 0x10, p 0) i .r1'
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ${If} $0 >= 22000
    CreateFont $ObFontTitle "Segoe UI Variable Display" 20 400
    CreateFont $ObFontLead "Segoe UI Variable Text" 11 400
    CreateFont $ObFontBody "Segoe UI Variable Text" 10 400
  ${Else}
    CreateFont $ObFontTitle "Segoe UI" 20 400
    CreateFont $ObFontLead "Segoe UI" 11 400
    CreateFont $ObFontBody "Segoe UI" 10 400
  ${EndIf}
  ${If} $1 <> 0
    CreateFont $ObFontTitle "Literata" 20 400
  ${EndIf}
FunctionEnd

; Mockup button order: Cancel on the left, the primary button on the right. Swaps the
; Next and Cancel buttons once; they keep these positions on every later page.
Function ${UN}ObSwapButtons
  ${If} $ObSwapped == 1
    Return
  ${EndIf}
  StrCpy $ObSwapped 1
  GetDlgItem $8 $HWNDPARENT 1
  GetDlgItem $9 $HWNDPARENT 2
  System::Call '*(i,i,i,i,i,i,i,i) p .r3'
  System::Call 'user32::GetWindowRect(p r8, p r3)'
  IntOp $4 $3 + 16
  System::Call 'user32::GetWindowRect(p r9, p r4)'
  System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r3, i 4)'
  System::Call '*$3(i .r4, i .r5, i, i, i .r6, i .r7)'
  System::Free $3
  System::Call 'user32::SetWindowPos(p r8, p 0, i r6, i r7, i 0, i 0, i 0x15)'
  System::Call 'user32::SetWindowPos(p r9, p 0, i r4, i r5, i 0, i 0, i 0x15)'
FunctionEnd

; Full-window page: hide the MUI header and branding, colour page and footer.
Function ${UN}ObFullWindow
  LockWindow on
  ShowWindow $mui.Branding.Background ${SW_HIDE}
  ShowWindow $mui.Branding.Text ${SW_HIDE}
  ShowWindow $mui.Header.Text ${SW_HIDE}
  ShowWindow $mui.Header.SubText ${SW_HIDE}
  ShowWindow $mui.Header.Image ${SW_HIDE}
  ShowWindow $mui.Line.Standard ${SW_HIDE}
  ShowWindow $mui.Line.FullWindow ${SW_NORMAL}
  SetCtlColors $HWNDPARENT "" "${OB_BG}"
  LockWindow off
FunctionEnd

Function ${UN}ObNormalWindow
  LockWindow on
  ShowWindow $mui.Branding.Background ${SW_NORMAL}
  ShowWindow $mui.Branding.Text ${SW_NORMAL}
  ShowWindow $mui.Header.Text ${SW_NORMAL}
  ShowWindow $mui.Header.SubText ${SW_NORMAL}
  ShowWindow $mui.Header.Image ${SW_NORMAL}
  ShowWindow $mui.Line.Standard ${SW_NORMAL}
  ShowWindow $mui.Line.FullWindow ${SW_HIDE}
  LockWindow off
FunctionEnd

; Title + lead text block shared by ob1 and ob3. $0 = title, $1 = lead.
Function ${UN}ObTitleLead
  ${NSD_CreateLabel} 26u 64u 280u 24u "$0"
  Pop $2
  SetCtlColors $2 "${OB_TEXT}" "${OB_SURFACE}"
  SendMessage $2 ${WM_SETFONT} $ObFontTitle 1
  ${NSD_CreateLabel} 26u 92u 280u 34u "$1"
  Pop $2
  SetCtlColors $2 "${OB_MUTED}" "${OB_SURFACE}"
  SendMessage $2 ${WM_SETFONT} $ObFontLead 1
FunctionEnd

; Page art. $0 = bitmap file name in OB_DIR.
Function ${UN}ObTile
  ${NSD_CreateBitmap} 26u 18u 40u 40u ""
  Pop $2
  ${NSD_SetStretchedImage} $2 "$PLUGINSDIR\$0" $ObImage
FunctionEnd

; Dialog units to pixels for the inner dialog $R0: $R1..$R4 = x y w h in, out in pixels.
Function ${UN}ObDlgRect
  IntOp $R3 $R1 + $R3
  IntOp $R4 $R2 + $R4
  System::Call '*(i R1, i R2, i R3, i R4) p .r3'
  System::Call 'user32::MapDialogRect(p R0, p r3)'
  System::Call '*$3(i .R1, i .R2, i .R3, i .R4)'
  System::Free $3
  IntOp $R3 $R3 - $R1
  IntOp $R4 $R4 - $R2
FunctionEnd

; Static control on $R0 at $R1..$R4 (pixels). $5 = text, $6 = style. Returns hwnd in $7.
Function ${UN}ObStatic
  System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t r5, i r6, i R1, i R2, i R3, i R4, p R0, p 0, p 0, p 0) p .r7'
FunctionEnd

!macroend
!insertmacro OB_HELPERS ""
!insertmacro OB_HELPERS "un."

Function ObWelcomeCreate
  Call SkipIfPassive ; aborts (skips) the page in passive mode
  InitPluginsDir
  File "/oname=$PLUGINSDIR\ob-logo.bmp" "${OB_DIR}\ob-logo.bmp"
  Call ObFonts
  nsDialogs::Create 1044
  Pop $ObDialog
  ${If} $ObDialog == error
    Abort
  ${EndIf}
  SetCtlColors $ObDialog "" "${OB_SURFACE}"
  StrCpy $0 "ob-logo.bmp"
  Call ObTile
  StrCpy $0 "Welcome to swarmDraft"
  StrCpy $1 "This will put swarmDraft on your computer. It takes about a minute, and you don't need to change anything."
  Call ObTitleLead
  ; Primary button reads "Install"; there is nothing to go back to.
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Install"
  Call ObSwapButtons
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  Call ObFullWindow
  nsDialogs::Show
  ${NSD_FreeImage} $ObImage
  Call ObNormalWindow
FunctionEnd

Function ObWelcomeLeave
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_NORMAL}
FunctionEnd

; ob2 layout for the stock install and uninstall progress pages.
!macro OB_PROGRESS_SHOW UN TITLE LEAD
Function ${UN}ObProgressShow
  Call ${UN}ObFonts
  Call ${UN}ObSwapButtons
  InitPluginsDir
  File "/oname=$PLUGINSDIR\ob-logo.bmp" "${OB_DIR}\ob-logo.bmp"
  LockWindow on
  Call ${UN}ObFullWindow
  ; Only Cancel: hide Back and Next (shown again on the finish page or if the install fails).
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  FindWindow $R0 "#32770" "" $HWNDPARENT
  ; Grow the page over the hidden header: full client width, down to the footer line.
  System::Call '*(i,i,i,i) p .r3'
  System::Call 'user32::GetWindowRect(p $mui.Line.FullWindow, p r3)'
  System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r3, i 2)'
  System::Call '*$3(i, i .r5, i, i)'
  System::Call 'user32::GetClientRect(p $HWNDPARENT, p r3)'
  System::Call '*$3(i, i, i .r6, i)'
  System::Free $3
  System::Call 'user32::SetWindowPos(p R0, p 0, i 0, i 0, i r6, i r5, i 0x14)'
  SetCtlColors $R0 "" "${OB_SURFACE}"
  ; No status line, log or details button.
  GetDlgItem $0 $R0 1006
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $R0 1016
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $R0 1027
  ShowWindow $0 ${SW_HIDE}
  ; Ribbon tile, same place as on ob1.
  StrCpy $R1 26
  StrCpy $R2 18
  StrCpy $R3 40
  StrCpy $R4 40
  Call ${UN}ObDlgRect
  StrCpy $5 ""
  StrCpy $6 0x5000000E ; WS_CHILD | WS_VISIBLE | SS_BITMAP
  Call ${UN}ObStatic
  System::Call 'user32::LoadImage(p 0, t "$PLUGINSDIR\ob-logo.bmp", i 0, i R3, i R4, i 0x10) p .r0'
  SendMessage $7 0x172 0 $0 ; STM_SETIMAGE, IMAGE_BITMAP
  ; Title and line.
  StrCpy $R1 26
  StrCpy $R2 64
  StrCpy $R3 280
  StrCpy $R4 24
  Call ${UN}ObDlgRect
  StrCpy $5 "${TITLE}"
  StrCpy $6 0x50000000
  Call ${UN}ObStatic
  SetCtlColors $7 "${OB_TEXT}" "${OB_SURFACE}"
  SendMessage $7 ${WM_SETFONT} $ObFontTitle 1
  StrCpy $R1 26
  StrCpy $R2 92
  StrCpy $R3 280
  StrCpy $R4 34
  Call ${UN}ObDlgRect
  StrCpy $5 "${LEAD}"
  Call ${UN}ObStatic
  SetCtlColors $7 "${OB_MUTED}" "${OB_SURFACE}"
  SendMessage $7 ${WM_SETFONT} $ObFontLead 1
  ; One wide progress bar in the accent colour.
  StrCpy $R1 26
  StrCpy $R2 132
  StrCpy $R3 280
  StrCpy $R4 6
  Call ${UN}ObDlgRect
  GetDlgItem $2 $R0 1004
  System::Call 'user32::SetWindowPos(p r2, p 0, i R1, i R2, i R3, i R4, i 0x14)'
  System::Call 'uxtheme::SetWindowTheme(p r2, w " ", w " ")'
  SendMessage $2 ${PBM_SETBARCOLOR} 0 ${OB_ACCENT_BGR}
  SendMessage $2 ${PBM_SETBKCOLOR} 0 ${OB_BORDER_BGR}
  LockWindow off
FunctionEnd

!macroend
!insertmacro OB_PROGRESS_SHOW "" "Installing swarmDraft…" "Almost there. You can keep using your computer while this finishes."

; If the install fails the page stays; give the buttons back so the user can close it.
Function .onInstFailed
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_NORMAL}
FunctionEnd

Function ObFinishCreate
  Call SkipIfPassive ; aborts (skips) the page in passive mode
  InitPluginsDir
  File "/oname=$PLUGINSDIR\ob-check.bmp" "${OB_DIR}\ob-check.bmp"
  Call ObFonts
  nsDialogs::Create 1044
  Pop $ObDialog
  ${If} $ObDialog == error
    Abort
  ${EndIf}
  SetCtlColors $ObDialog "" "${OB_SURFACE}"
  StrCpy $0 "ob-check.bmp"
  Call ObTile
  StrCpy $0 "swarmDraft is ready"
  StrCpy $1 "You'll find it in your Start menu and on your desktop."
  Call ObTitleLead
  ${NSD_CreateCheckbox} 26u 134u 280u 14u "Open swarmDraft now"
  Pop $ObRunCheckbox
  SetCtlColors $ObRunCheckbox "${OB_TEXT}" "${OB_SURFACE}"
  SendMessage $ObRunCheckbox ${WM_SETFONT} $ObFontBody 1
  ${NSD_Check} $ObRunCheckbox
  ; Only a Finish button: the install is done, so Back and Cancel are hidden.
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Finish"
  ShowWindow $0 ${SW_NORMAL}
  Call ObSwapButtons
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  Call ObFullWindow
  nsDialogs::Show
  ${NSD_FreeImage} $ObImage
  Call ObNormalWindow
FunctionEnd

Function ObFinishLeave
  ${NSD_GetState} $ObRunCheckbox $ObRunState
  ${If} $ObRunState = ${BST_CHECKED}
    Call RunMainBinary
  ${EndIf}
FunctionEnd

Function RunMainBinary
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

; Uninstaller Pages
; swarmDraft: custom nsDialogs pages in the ob1 to ob3 layout instead of the stock confirm and
; finish pages; the stock progress page gets the ob2 layout. Passive and update runs skip them.
; 1. Confirm uninstall page (keeps the "delete app data" choice, unticked by default)
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState
UninstPage custom un.ObConfirmCreate un.ObConfirmLeave

; 2. Uninstalling Page
!define MUI_PAGE_HEADER_TEXT "Removing swarmDraft…"
!define MUI_PAGE_HEADER_SUBTEXT "This only takes a moment."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ObProgressShow
!insertmacro MUI_UNPAGE_INSTFILES

; 3. Finish page
UninstPage custom un.ObFinishCreate un.ObFinishLeave

!insertmacro OB_PROGRESS_SHOW "un." "Removing swarmDraft…" "This only takes a moment."

Function un.ObConfirmCreate
  Call un.SkipIfPassive ; aborts (skips) the page in passive mode
  InitPluginsDir
  File "/oname=$PLUGINSDIR\ob-logo.bmp" "${OB_DIR}\ob-logo.bmp"
  Call un.ObFonts
  nsDialogs::Create 1044
  Pop $ObDialog
  ${If} $ObDialog == error
    Abort
  ${EndIf}
  ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}
  SetCtlColors $ObDialog "" "${OB_SURFACE}"
  StrCpy $0 "ob-logo.bmp"
  Call un.ObTile
  StrCpy $0 "Uninstall swarmDraft?"
  StrCpy $1 "This removes the app from this computer. Your manuscripts and settings stay unless you choose to delete them below."
  Call un.ObTitleLead
  ${NSD_CreateCheckbox} 26u 134u 280u 14u "Also delete my manuscripts and settings"
  Pop $DeleteAppDataCheckbox
  SetCtlColors $DeleteAppDataCheckbox "${OB_TEXT}" "${OB_SURFACE}"
  SendMessage $DeleteAppDataCheckbox ${WM_SETFONT} $ObFontBody 1
  ${If} $DeleteAppDataCheckboxState = ${BST_CHECKED}
    ${NSD_Check} $DeleteAppDataCheckbox
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Uninstall"
  Call un.ObSwapButtons
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  Call un.ObFullWindow
  nsDialogs::Show
  ${NSD_FreeImage} $ObImage
  Call un.ObNormalWindow
FunctionEnd

Function un.ObConfirmLeave
  ${NSD_GetState} $DeleteAppDataCheckbox $DeleteAppDataCheckboxState
FunctionEnd

Function un.ObFinishCreate
  Call un.SkipIfPassive
  ${IfThen} $UpdateMode = 1 ${|} Abort ${|}
  InitPluginsDir
  File "/oname=$PLUGINSDIR\ob-check.bmp" "${OB_DIR}\ob-check.bmp"
  Call un.ObFonts
  nsDialogs::Create 1044
  Pop $ObDialog
  ${If} $ObDialog == error
    Abort
  ${EndIf}
  ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}
  SetCtlColors $ObDialog "" "${OB_SURFACE}"
  StrCpy $0 "ob-check.bmp"
  Call un.ObTile
  StrCpy $0 "swarmDraft was removed"
  ${If} $DeleteAppDataCheckboxState = ${BST_CHECKED}
    StrCpy $1 "The app and its data are gone from this computer."
  ${Else}
    StrCpy $1 "Your manuscripts are still on this computer. They'll be there if you install swarmDraft again."
  ${EndIf}
  Call un.ObTitleLead
  ; Only a Finish button.
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Finish"
  ShowWindow $0 ${SW_NORMAL}
  EnableWindow $0 1
  Call un.ObSwapButtons
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  Call un.ObFullWindow
  nsDialogs::Show
  ${NSD_FreeImage} $ObImage
  Call un.ObNormalWindow
FunctionEnd

Function un.ObFinishLeave
FunctionEnd

; If the uninstall fails the page stays; give the buttons back so the user can close it.
Function un.onUninstFailed
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_NORMAL}
FunctionEnd

;Languages
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}

Function .onInit
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !insertmacro SetContext

  ${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; Set default install location
    !if "${INSTALLMODE}" == "perMachine"
      ${If} ${RunningX64}
        !if "${ARCH}" == "x64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else if "${ARCH}" == "arm64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else
          StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
        !endif
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else if "${INSTALLMODE}" == "currentUser"
      StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    !endif

    Call RestorePreviousInstallLocation
  ${EndIf}


  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_INIT
  !endif

  ; Abort downgrades if they are disabled, in the modes that skip the reinstall page choice:
  ; silent, passive and update
  !if "${ALLOWDOWNGRADES}" == "false"
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    ; Compare with the same installation the reinstall page would: a WiX one first
    Call FindWixInstall
    ${If} $R6 != ""
      ReadRegStr $R0 HKLM "$R6" "DisplayVersion"
    ${Else}
      ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
    ${EndIf}
    nsis_tauri_utils::SemverCompare "${VERSION}" $R0
    Pop $R0
    ; If downgrading
    ${If} $R0 = -1
      ${If} ${Silent}
        System::Call 'kernel32::AttachConsole(i -1)i.r0'
        ${If} $0 <> 0
          System::Call 'kernel32::GetStdHandle(i -11)i.r0'
          System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)' ; set red color
          FileWrite $0 "$(silentDowngrades)"
        ${EndIf}
      ${Else}
        MessageBox MB_ICONSTOP "$(silentDowngrades)"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  !endif
FunctionEnd

Section WebView2
  ; Check if Webview2 is already installed and skip this section
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating
    ${If} $UpdateMode <> 1
      !if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        DetailPrint "$(webview2Downloading)"
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Pop $0
        ${If} $0 == "success"
          DetailPrint "$(webview2DownloadSuccess)"
        ${Else}
          DetailPrint "$(webview2DownloadError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
        Delete "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        Goto install_webview2
      !endif

      Goto webview2_done

      install_webview2:
        DetailPrint "$(installingWebview2)"
        ; $6 holds the path to the webview2 installer
        ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install" $1
        ${If} $1 = 0
          DetailPrint "$(webview2InstallSuccess)"
        ${Else}
          DetailPrint "$(webview2InstallError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "$(installingWebview2)"
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "$(webview2InstallSuccess)"
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
SectionEnd

Section Install
  SetOutPath $INSTDIR

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Copy main executable
  File "${MAINBINARYSRCPATH}"

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0" "Open with ${PRODUCTNAME}" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Save $INSTDIR in registry for future installations
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Remove old main binary if it doesn't match new main binary name
  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\$OldMainBinaryName"
  ${EndIf}

  ; Save current MAINBINARYNAME for future updates
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ; Create start menu shortcut
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    Call CreateOrUpdateStartMenuShortcut
  !insertmacro MUI_STARTMENU_WRITE_END

  ; swarmDraft: always create the desktop shortcut (interactive, passive and silent installs).
  ; CreateOrUpdateDesktopShortcut still leaves shortcuts alone for /UPDATE and /NS.
  Call CreateOrUpdateDesktopShortcut

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  ; swarmDraft: move on to the finish page as soon as the install succeeds (ob2 has no Next).
  SetAutoClose true
SectionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in silent and passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_UNINIT
  !endif

  !insertmacro MUI_UNGETLANGUAGE

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Section Uninstall

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete app associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"

  {{#each resources_ancestors}}
  RMDir /REBOOTOK "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  ; Removes the Autostart entry for ${PRODUCTNAME} from the HKCU Run key if it exists.
  ; This ensures the program does not launch automatically after uninstallation if it exists.
  ; If it doesn't exist, it does nothing.
  ; We do this when not updating (to preserve the registry value on updates)
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${EndIf}

  ; Delete app data if the checkbox is selected
  ; and if not updating
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Clear the install location $INSTDIR from registry
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"

    ; Clear the install language from registry
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"

    SetShellVarContext current
    ; swarmDraft: only the current identifier's folders. The pre-rename com.radiancelux.coauthor
    ; folders are the first-run migration source and are never deleted (see src/migrate.rs).
    !if "${BUNDLEID}" == "com.radiancelux.coauthor"
      !error "swarmDraft: the uninstaller must never delete the pre-rename data folders"
    !endif
    RmDir /r "$APPDATA\${BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; swarmDraft: always move on once removal succeeds (the progress page has no Next); the
  ; finish page skips itself in passive and update runs.
  SetAutoClose true
SectionEnd

Function RestorePreviousInstallLocation
  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
  StrCmp $4 "" +2 0
    StrCpy $INSTDIR $4
FunctionEnd

Function Skip
  Abort
FunctionEnd

Function SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd
Function un.SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  StrCpy $R0 0

  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
