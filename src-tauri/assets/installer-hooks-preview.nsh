!define MUI_WELCOMEPAGE_TEXT "Setup will install ABW Preview for your Windows account.$\r$\n$\r$\nABW Preview installs side-by-side with ABW using separate preferences and data."
!define ABW_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define ABW_PREF_KEY "Software\net.insidemedia.abw.preview"
!define MUI_CUSTOMFUNCTION_GUIINIT AbwCaptureStartup

Function AbwCaptureStartup
  ReadRegStr $R0 HKCU "${ABW_RUN_KEY}" "ABW Preview"
  StrCmp $R0 "" abw_capture_disabled
    WriteRegDWORD HKCU "${ABW_PREF_KEY}" "StartupEnabled" 1
    Return
  abw_capture_disabled:
  IfFileExists "$INSTDIR\abw.exe" 0 abw_capture_done
    WriteRegDWORD HKCU "${ABW_PREF_KEY}" "StartupEnabled" 0
  abw_capture_done:
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  IfSilent abw_preinstall_capture
  StrCmp $UpdateMode 1 abw_preinstall_capture
  StrCmp $PassiveMode 1 abw_preinstall_capture abw_preinstall_done
  abw_preinstall_capture:
    Call AbwCaptureStartup
  abw_preinstall_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ClearErrors
  ReadRegDWORD $R0 HKCU "${ABW_PREF_KEY}" "StartupEnabled"
  IfErrors abw_startup_new abw_startup_apply
  abw_startup_new:
    StrCpy $R0 0
    IfSilent abw_startup_apply
    StrCmp $UpdateMode 1 abw_startup_apply
    StrCmp $PassiveMode 1 abw_startup_apply
    MessageBox MB_YESNO|MB_ICONQUESTION "Start ABW Preview automatically when you sign in to Windows?" IDNO abw_startup_apply
    StrCpy $R0 1
  abw_startup_apply:
    WriteRegDWORD HKCU "${ABW_PREF_KEY}" "StartupEnabled" $R0
    StrCmp $R0 1 abw_startup_enable
    DeleteRegValue HKCU "${ABW_RUN_KEY}" "ABW Preview"
    Goto abw_startup_done
  abw_startup_enable:
    WriteRegStr HKCU "${ABW_RUN_KEY}" "ABW Preview" '"$INSTDIR\abw.exe"'
  abw_startup_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  StrCmp $UpdateMode 1 abw_uninstall_done
    DeleteRegValue HKCU "${ABW_RUN_KEY}" "ABW Preview"
    DeleteRegKey HKCU "${ABW_PREF_KEY}"
  abw_uninstall_done:
!macroend
