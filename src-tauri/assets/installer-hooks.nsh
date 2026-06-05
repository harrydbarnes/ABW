!define MUI_WELCOMEPAGE_TEXT "Setup will guide you through the installation of A Better Wrike.$\r$\n$\r$\nThis app is designed by Harry Barnes to improve upon the default Wrike client. No data is shared or processed differently to the standard Wrike client.$\r$\n$\r$\nClick next to continue."

!define ABW_STARTUP_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define ABW_STARTUP_REGISTRY_VALUE "ABW"

!macro NSIS_HOOK_POSTINSTALL
  IfSilent 0 +2
    Goto abw_startup_done

  MessageBox MB_YESNO|MB_ICONQUESTION "Start ABW automatically when you sign in to Windows?" IDYES abw_startup_enable IDNO abw_startup_disable

  abw_startup_enable:
    WriteRegStr HKCU "${ABW_STARTUP_REGISTRY_KEY}" "${ABW_STARTUP_REGISTRY_VALUE}" '"$INSTDIR\ABW.exe"'
    Goto abw_startup_done

  abw_startup_disable:
    DeleteRegValue HKCU "${ABW_STARTUP_REGISTRY_KEY}" "${ABW_STARTUP_REGISTRY_VALUE}"

  abw_startup_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "${ABW_STARTUP_REGISTRY_KEY}" "${ABW_STARTUP_REGISTRY_VALUE}"
!macroend
