; veraldar.nsi - Veraldar-Setup-<version>.exe: this Windows PC joins your tree as a root, in one window.
; ...........................................................................................................
; Per-user (no admin), except one UAC prompt when WSL itself must be installed. No terminal window: every
; command runs hidden and the window shows the result. Steps and the codes the last screen shows:
;   1  Windows 10 build 19041+ or 11, x86_64 .............................................. W-OS
;   2  WSL2 with a Debian/Ubuntu distribution (else: wsl --install, elevated, "Windows must restart", and
;      RunOnce brings this installer back with /continue); the Linux user, made without a password when the
;      distribution has none (wsl -u root useradd); curl, python3, openssh-client, ca-certificates (wsl -u root
;      apt-get) ......................................................................... W-WSL
;   3  the trunk address, pre-filled ${TRUNK_DEFAULT}
;   4  the root.sh embedded here (the stamped one of this release) runs inside WSL through wsl-bootstrap.sh,
;      hidden, with --trunk <the address above> --name <the computer name>; root.sh checks the release's
;      signature itself and enrolls this PC with your trunk's account (v1: no phone pairing scan)
;   5  the code and the QR in this window until the phone approves (10 minutes) .. W-NET W-SIG W-JOIN W-MODEL
;   6  approved: the start-at-login entry (keepalive.vbs -> launcher.bat), the root started ........ W-RUN
;   7  %LOCALAPPDATA%\Veraldar\install-report.txt: versions, each step, the last 40 log lines (masked)
; The Linux half (setup, join, step codes, masking, the QR as BMP) is wsl-bootstrap.sh; it talks to this
; window through status.ini / setup.ini in the install folder.
;
; Build: scripts/build-win.sh VERSION JOIN_SH OUTDIR (makensis in docker, -DAPPVERSION -DVIVERSION -DJOIN_SH
; -DOUTFILE). Tests: win/launcher-test.sh (wine, a fake wsl.exe), win/bootstrap-test.sh (the Linux half).
; ...........................................................................................................

Unicode true
!ifndef APPVERSION
  !define APPVERSION "0.0.0-dev"
!endif
!ifndef VIVERSION
  !define VIVERSION "0.0.0.0"
!endif
!ifndef JOIN_SH
  !define JOIN_SH "..\root\install\root.sh"
!endif
!ifndef OUTFILE
  !define OUTFILE "Veraldar-Setup-${APPVERSION}.exe"
!endif
; v1: no built-in trunk. The default is where this exe was downloaded from: a folder the trunk's
; page names (the browser saves Veraldar-Setup-<version>.exe into <Downloads>/<something>), else
; the address screen asks. (TRUNK_DEFAULT stays overridable for tests: -DTRUNK_DEFAULT=url.)
!ifndef TRUNK_DEFAULT
  !define TRUNK_DEFAULT ""
!endif
!define UNINST_KEY  "Software\Microsoft\Windows\CurrentVersion\Uninstall\Veraldar"
!define RUNONCE_KEY "Software\Microsoft\Windows\CurrentVersion\RunOnce"
!define NTCV_KEY    "SOFTWARE\Microsoft\Windows NT\CurrentVersion"
; The model step's providers — the SAME table as root/install/model-step.sh (win/model-step-check.sh compares
; them): label, address, kind, models (the default first).
!define P_SAME_LABEL       "Same as the home root"
!define P_ZAI_LABEL        "Z AI"
!define P_ZAI_URL          "https://api.z.ai/api/anthropic"
!define P_ZAI_STYLE        "anthropic"
!define P_ZAI_MODELS       "glm-5.3-flash glm-5.3 glm-5.2"
!define P_OPENROUTER_LABEL "OpenRouter"
!define P_OPENROUTER_URL   "https://openrouter.ai/api/v1"
!define P_OPENROUTER_STYLE "openai"
!define P_OPENROUTER_MODELS "openai/gpt-4o-mini"
!define P_ANTHROPIC_LABEL  "Anthropic"
!define P_ANTHROPIC_URL    "https://api.anthropic.com"
!define P_ANTHROPIC_STYLE  "anthropic"
!define P_ANTHROPIC_MODELS "claude-fable-5-2 claude-opus-5-5 claude-sonnet-5-5 claude-haiku-5-5"
!define P_OPENAI_LABEL     "OpenAI"
!define P_OPENAI_URL       "https://api.openai.com/v1"
!define P_OPENAI_STYLE     "openai"
!define P_OPENAI_MODELS    "gpt-4o-mini"
!define P_OTHER_LABEL      "Other"
!define QR_WAIT_MS   660000   ; the hub keeps a join request 10 minutes; join.sh gives up 30 s after that
!define PREP_WAIT_MS 2400000  ; no code after 40 minutes (the release download): give up

Name "Veraldar"
Caption "Veraldar Setup"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Veraldar"
RequestExecutionLevel user
SetCompressor /SOLID lzma
CRCCheck on
BrandingText " "
ShowInstDetails nevershow
ShowUninstDetails nevershow
XPStyle on
VIProductVersion "${VIVERSION}"
VIAddVersionKey "ProductName" "Veraldar"
VIAddVersionKey "ProductVersion" "${APPVERSION}"
VIAddVersionKey "FileVersion" "${APPVERSION}"
VIAddVersionKey "FileDescription" "Veraldar Setup"
VIAddVersionKey "CompanyName" "veraldar"
VIAddVersionKey "LegalCopyright" "veraldar"

!include MUI2.nsh
!include nsDialogs.nsh
!include LogicLib.nsh
!include WinVer.nsh
!include x64.nsh
!include FileFunc.nsh
!include TextFunc.nsh
!include WinMessages.nsh
!ifndef PBS_MARQUEE
  !define PBS_MARQUEE 0x08
!endif
!ifndef PBM_SETMARQUEE
  !define PBM_SETMARQUEE 0x40A
!endif

Var Wsl          ; wsl.exe (Sysnative: this installer is 32-bit)
Var Continue     ; 1: started again after the restart (RunOnce, /continue)
Var WinDesc
Var WinUser
Var CompName
Var Distro       ; the WSL distribution, its Linux user, the install folder as WSL sees it
Var LUser
Var PDistro      ; what the last probe saw
Var PUser
Var PUid
Var PLike
Var PKernel
Var PPretty
Var WslVer
Var InstalledWsl ; 1: this run installed WSL (elevated)
Var NeedRestart
Var Trunk
Var Result       ; "" = connected; else a step code
Var Why          ; one line for the report
Var StepOS
Var StepWSL
Var StepAddr
Var StepJoin
Var StepRun
Var JoinProc
Var JoinRc
Var JoinStart
Var CodeTick
Var CodeShown
Var Ended
Var AtEnd        ; 1: the last page is up (closing the window then is not a cancel)
Var RptH
Var hAddr
Var hWait
Var hBar
Var hQR
Var hQRImg
Var hTitle
Var hCode
Var hHint
Var FontBig
Var FontCode
Var Name          ; uninstaller: the root's name
Var HaveModel     ; 1: this PC's root already has its model (setup.ini model=1): the model page is not shown
Var StepModel
Var hProv         ; the model step (the same choices and words as root/install/model-step.sh)
Var hPKeyLbl      ; a provider: its key, its model (the default shown, changeable)
Var hPKey
Var hPModelLbl
Var hPModel
Var hOAddrLbl     ; Other: address, kind, model, key
Var hUpUrl
Var hOKindLbl
Var hUpKind
Var hOModelLbl
Var hUpModel
Var hOKeyLbl
Var hUpKey
Var hOHint

; ------------------------------------------------------------------------------------------------- pages
!define MUI_CUSTOMFUNCTION_ABORT OnUserAbort
!define MUI_PAGE_HEADER_TEXT "Getting this PC ready"
!define MUI_PAGE_HEADER_SUBTEXT "This can take a few minutes."
!define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "Getting this PC ready"
!define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT " "
!define MUI_INSTFILESPAGE_ABORTHEADER_TEXT "Stopped"
!define MUI_INSTFILESPAGE_ABORTHEADER_SUBTEXT " "
!insertmacro MUI_PAGE_INSTFILES
Page custom RestartShow RestartLeave
Page custom AddressShow AddressLeave
Page custom ModelShow ModelLeave
Page custom JoinShow
Page custom DoneShow

UninstPage custom un.ConfirmShow
!define MUI_PAGE_HEADER_TEXT "Removing Veraldar"
!define MUI_PAGE_HEADER_SUBTEXT " "
!define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "Removing Veraldar"
!define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT " "
!insertmacro MUI_UNPAGE_INSTFILES
UninstPage custom un.DoneShow

!insertmacro MUI_LANGUAGE "English"

; ------------------------------------------------------------------------------------------------ helpers
!macro LOG TEXT
  Push "${TEXT}"
  Call Log
!macroend
!define Log "!insertmacro LOG"
Function Log ; one line into setup.log (the report quotes its end); nothing secret is ever logged here
  Exch $0
  Push $1
  ClearErrors
  FileOpen $1 "$INSTDIR\setup.log" a
  ${IfNot} ${Errors}
    FileSeek $1 0 END
    FileWrite $1 "[setup] $0$\r$\n"
    FileClose $1
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

!macro FIND_WSL UN
Function ${UN}FindWsl
  ${If} ${FileExists} "$WINDIR\Sysnative\wsl.exe"
    StrCpy $Wsl "$WINDIR\Sysnative\wsl.exe"
  ${ElseIf} ${FileExists} "$SYSDIR\wsl.exe"
    StrCpy $Wsl "$SYSDIR\wsl.exe"
  ${Else}
    StrCpy $Wsl "wsl.exe"
  ${EndIf}
FunctionEnd
!macroend
!insertmacro FIND_WSL ""
!insertmacro FIND_WSL "un."

Function TrimNL ; $0 without trailing CR/LF/blanks
  Push $1
  loop:
    StrCpy $1 $0 1 -1
    ${If} $1 == "$\r"
    ${OrIf} $1 == "$\n"
    ${OrIf} $1 == " "
      StrCpy $0 $0 -1
      Goto loop
    ${EndIf}
  Pop $1
FunctionEnd

Function Field ; $0 STRING, $1 INDEX (1-based) -> $2 the INDEX-th ':'-separated field (the last one: the rest)
  Push $3
  Push $4
  Push $5
  Push $6
  StrCpy $2 ""
  StrCpy $3 0   ; position
  StrCpy $4 0   ; where the field starts
  StrCpy $5 1   ; field number
  loop:
    StrCpy $6 $0 1 $3
    ${If} $6 == ""
      ${If} $5 = $1
        StrCpy $2 $0 "" $4
      ${EndIf}
      Goto done
    ${EndIf}
    ${If} $6 == ":"
    ${AndIf} $5 < 6
      ${If} $5 = $1
        IntOp $6 $3 - $4
        StrCpy $2 $0 $6 $4
        Goto done
      ${EndIf}
      IntOp $5 $5 + 1
      IntOp $4 $3 + 1
    ${EndIf}
    IntOp $3 $3 + 1
    Goto loop
  done:
  Pop $6
  Pop $5
  Pop $4
  Pop $3
FunctionEnd

Function StartHidden ; $1 command line -> $4 process handle (0: did not start), $5 the error
  ; CreateProcess with CREATE_NO_WINDOW: no console window at all (not even a hidden one Windows Terminal
  ; could pick up)
  System::Call '*(&l4, p 0, p 0, p 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 1, &i2 0, &i2 0, p 0, p 0, p 0, p 0) p .r6'
  System::Call '*(p 0, p 0, i 0, i 0) p .r7'
  System::Call 'kernel32::CreateProcessW(p 0, w r1, p 0, p 0, i 0, i 0x08000000, p 0, p 0, p r6, p r7) i .r8 ?e'
  Pop $5
  StrCpy $4 0
  ${If} $8 <> 0
    System::Call '*$7(p .r4, p .r9, i, i)'
    System::Call 'kernel32::CloseHandle(p r9)'
  ${EndIf}
  System::Free $6
  System::Free $7
FunctionEnd

Function RunElevated ; $1 file, $2 parameters -> $4 exit code ("" if it did not start), $5 the error
  ; ShellExecuteEx "runas": the one UAC prompt; then wait for it
  System::Call '*(&l4, i 0x40, p $HWNDPARENT, w "runas", w r1, w r2, p 0, i 0, p 0, p 0, p 0, p 0, i 0, p 0, p 0) p .r6'
  System::Call 'shell32::ShellExecuteExW(p r6) i .r8 ?e'
  Pop $5
  StrCpy $4 ""
  ${If} $8 <> 0
    System::Call '*$6(i, i, p, p, p, p, p, i, p, p, p, p, i, p, p .r7)'
    ${If} $7 <> 0
      System::Call 'kernel32::WaitForSingleObject(p r7, i -1) i .r8'
      System::Call 'kernel32::GetExitCodeProcess(p r7, *i .r4) i .r8'
      System::Call 'kernel32::CloseHandle(p r7)'
    ${Else}
      StrCpy $4 0
    ${EndIf}
  ${EndIf}
  System::Free $6
FunctionEnd

Function DescribeWindows ; -> $WinDesc, e.g. "Windows 11 Professional 23H2 (build 22631.4460), x86_64"
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}
  ReadRegStr $0 HKLM "${NTCV_KEY}" "DisplayVersion"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "${NTCV_KEY}" "ReleaseId"
  ${EndIf}
  ReadRegDWORD $1 HKLM "${NTCV_KEY}" "UBR"
  ReadRegStr $2 HKLM "${NTCV_KEY}" "EditionID"
  SetRegView lastused
  ${WinVerGetBuild} $3
  StrCpy $4 "Windows 10"
  ${If} $3 >= 22000
    StrCpy $4 "Windows 11"
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    StrCpy $4 "Windows (older than 10)"
  ${EndIf}
  ${If} ${IsNativeAMD64}
    StrCpy $5 "x86_64"
  ${ElseIf} ${IsNativeARM64}
    StrCpy $5 "arm64"
  ${Else}
    StrCpy $5 "x86"
  ${EndIf}
  ${If} $2 != ""
    StrCpy $4 "$4 $2"
  ${EndIf}
  ${If} $0 != ""
    StrCpy $4 "$4 $0"
  ${EndIf}
  ${If} $1 != ""
    StrCpy $3 "$3.$1"
  ${EndIf}
  StrCpy $WinDesc "$4 (build $3), $5"
FunctionEnd

Function ReportLine ; LineFind callback: a line of setup.log into the report
  FileWrite $RptH $R9
  Push 0
FunctionEnd

Function WriteReport ; step 7: install-report.txt - no secrets (setup.log is masked by wsl-bootstrap.sh)
  ClearErrors
  FileOpen $RptH "$INSTDIR\install-report.txt" w
  ${If} ${Errors}
    Return
  ${EndIf}
  ${If} $Result == ""
    StrCpy $0 "connected as $CompName"
  ${Else}
    StrCpy $0 "$Result"
    ${If} $Why != ""
      StrCpy $0 "$Result - $Why"
    ${EndIf}
  ${EndIf}
  ${If} $NeedRestart == 1
    StrCpy $0 "waiting for the restart (WSL installed)"
  ${EndIf}
  FileWrite $RptH "Veraldar install report$\r$\n"
  FileWrite $RptH "installer:  Veraldar-Setup ${APPVERSION}$\r$\n"
  FileWrite $RptH "windows:    $WinDesc$\r$\n"
  FileWrite $RptH "wsl:        $WslVer$\r$\n"
  FileWrite $RptH "distro:     $Distro ($PPretty), kernel $PKernel, Linux user $LUser$\r$\n"
  FileWrite $RptH "result:     $0$\r$\n"
  FileWrite $RptH "$\r$\nsteps$\r$\n"
  FileWrite $RptH "  1 windows    $StepOS$\r$\n"
  FileWrite $RptH "  2 wsl        $StepWSL$\r$\n"
  FileWrite $RptH "  3 address    $StepAddr$\r$\n"
  ${If} $HaveModel == 1
    FileWrite $RptH "  3 model      already set on this PC$\r$\n"
  ${Else}
    FileWrite $RptH "  3 model      $StepModel$\r$\n"
  ${EndIf}
  FileWrite $RptH "  4-5 join     $StepJoin$\r$\n"
  FileWrite $RptH "  6 run        $StepRun$\r$\n"
  FileWrite $RptH "$\r$\nlast 40 log lines (setup.log; keys and tokens masked)$\r$\n"
  ${If} ${FileExists} "$INSTDIR\setup.log"
    ${LineFind} "$INSTDIR\setup.log" "/NUL" "-40:-1" ReportLine
  ${EndIf}
  FileClose $RptH
FunctionEnd

; ---------------------------------------------------------------------------------------------- step 2
Function Probe ; $0 "" (the default distribution) or a name -> $1 1 when a Debian/Ubuntu distribution answered
  StrCpy $1 0
  StrCpy $9 '-e sh -c ". /etc/os-release; echo vb:$$WSL_DISTRO_NAME:$$(id -un):$$(id -u):$$ID $$ID_LIKE:$$(uname -r):$$PRETTY_NAME"'
  ${If} $0 != ""
    StrCpy $9 "-d $0 $9"
  ${EndIf}
  nsExec::ExecToStack /TIMEOUT=180000 '"$Wsl" $9'
  Pop $2
  Pop $3
  ${If} $2 != 0
    ${Log} "probe $0: no answer (exit $2)"
    Return
  ${EndIf}
  ; the line starting with vb: (WSL may print a notice before it)
  StrCpy $4 0
  find:
    StrCpy $5 $3 3 $4
    ${If} $5 == ""
      ${Log} "probe $0: no distribution line"
      Return
    ${EndIf}
    ${If} $5 != "vb:"
      IntOp $4 $4 + 1
      Goto find
    ${EndIf}
  IntOp $4 $4 + 3
  StrCpy $0 $3 "" $4
  Call TrimNL
  StrCpy $1 1
  Call Field
  StrCpy $PDistro $2
  StrCpy $1 2
  Call Field
  StrCpy $PUser $2
  StrCpy $1 3
  Call Field
  StrCpy $PUid $2
  StrCpy $1 4
  Call Field
  StrCpy $PLike " $2 "
  StrCpy $1 5
  Call Field
  StrCpy $PKernel $2
  StrCpy $1 6
  Call Field
  StrCpy $PPretty $2
  ${Log} "probe: $PDistro ($PPretty), like$PLike, user $PUser ($PUid), kernel $PKernel"
  StrCpy $1 0
  ${If} $PDistro == ""
    Return
  ${EndIf}
  ; Debian or Ubuntu (or one of theirs)?
  StrCpy $4 0
  like:
    StrCpy $5 $PLike 8 $4
    ${If} $5 == ""
      ${Log} "probe: $PDistro is not Debian or Ubuntu"
      Return
    ${EndIf}
    ${If} $5 == " debian "
    ${OrIf} $5 == " ubuntu "
      StrCpy $1 1
      Return
    ${EndIf}
    IntOp $4 $4 + 1
    Goto like
FunctionEnd

Function FindDistro ; -> $Distro (empty: none to use)
  StrCpy $Distro ""
  StrCpy $0 ""
  Call Probe
  ${If} $1 = 1
    StrCpy $Distro $PDistro
    Return
  ${EndIf}
  StrCpy $0 "Ubuntu"
  Call Probe
  ${If} $1 = 1
    StrCpy $Distro $PDistro
  ${EndIf}
FunctionEnd

Function RegisterUbuntu ; Ubuntu installed as an app but not set up yet: set it up without a Linux user question
  StrCpy $0 "$LOCALAPPDATA\Microsoft\WindowsApps\ubuntu.exe"
  ${If} ${FileExists} $0
    DetailPrint "Setting up Ubuntu"
    nsExec::ExecToStack /TIMEOUT=1200000 '"$0" install --root'
    Pop $1
    Pop $2
    ${Log} "ubuntu.exe install --root: exit $1"
  ${EndIf}
FunctionEnd

Function WslVersion ; -> $WslVer (first line of wsl --version; WSL_UTF8=1 keeps it readable)
  nsExec::ExecToStack /TIMEOUT=60000 '"$Wsl" --version'
  Pop $1
  Pop $0
  StrCpy $WslVer "?"
  ${If} $1 == 0
    StrCpy $2 0
    nl:
      StrCpy $3 $0 1 $2
      ${If} $3 != ""
      ${AndIf} $3 != "$\r"
      ${AndIf} $3 != "$\n"
        IntOp $2 $2 + 1
        Goto nl
      ${EndIf}
    StrCpy $WslVer $0 $2
  ${Else}
    StrCpy $WslVer "wsl --version: exit $1 (an older, built-in WSL)"
  ${EndIf}
FunctionEnd

Section "-prepare"
  SetOutPath "$INSTDIR"
  File "wsl-bootstrap.sh"
  File "/oname=root.sh" "${JOIN_SH}"
  File "launcher.bat"
  File "keepalive.vbs"
  Delete "$INSTDIR\status.ini"
  Delete "$INSTDIR\setup.ini"
  Delete "$INSTDIR\join-qr.bmp"
  ${If} "$EXEPATH" != "$INSTDIR\Veraldar-Setup.exe"
    CopyFiles /SILENT "$EXEPATH" "$INSTDIR\Veraldar-Setup.exe"
  ${EndIf}
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Veraldar"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APPVERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "veraldar"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ; ---- step 2: WSL and a Debian/Ubuntu distribution
  DetailPrint "Checking WSL"
  Call FindDistro
  ${If} $Distro == ""
    ${If} $Continue == 1
      ; after the restart: Ubuntu may need setting up, or installing (WSL is there now: no admin needed)
      Call RegisterUbuntu
      Call FindDistro
      ${If} $Distro == ""
        DetailPrint "Installing Ubuntu"
        nsExec::ExecToStack /TIMEOUT=2400000 '"$Wsl" --install -d Ubuntu --no-launch'
        Pop $1
        Pop $2
        ${Log} "wsl --install -d Ubuntu --no-launch (after the restart): exit $1"
        Call RegisterUbuntu
        Call FindDistro
      ${EndIf}
    ${Else}
      DetailPrint "Installing WSL. Windows asks for permission."
      ${Log} "installing WSL: wsl --install -d Ubuntu --no-launch (elevated)"
      StrCpy $1 "$WINDIR\System32\wsl.exe"
      StrCpy $2 "--install -d Ubuntu --no-launch"
      ${DisableX64FSRedirection}
      Call RunElevated
      ${EnableX64FSRedirection}
      ${If} $4 == ""
        ${Log} "the WSL install did not start (error $5)"
        StrCpy $Result "W-WSL"
        StrCpy $Why "WSL was not installed (no permission, error $5)"
        StrCpy $StepWSL "failed: $Why"
        Goto done
      ${EndIf}
      ${Log} "wsl --install: exit $4"
      ${If} $4 <> 0
      ${AndIf} $4 <> 3010
      ${AndIf} $4 <> 1641
        StrCpy $Result "W-WSL"
        StrCpy $Why "wsl --install failed (exit $4)"
        StrCpy $StepWSL "failed: $Why"
        Goto done
      ${EndIf}
      StrCpy $InstalledWsl 1
      DetailPrint "Setting up Ubuntu"
      Call RegisterUbuntu
      Call FindDistro
    ${EndIf}
  ${EndIf}
  ${If} $Distro == ""
    ${If} $InstalledWsl == 1
      ; WSL itself was new: Windows restarts, then this installer goes on by itself
      StrCpy $NeedRestart 1
      WriteRegStr HKCU "${RUNONCE_KEY}" "Veraldar" '"$INSTDIR\Veraldar-Setup.exe" /continue'
      StrCpy $StepWSL "WSL installed, Windows must restart (RunOnce: Veraldar-Setup.exe /continue)"
      ${Log} "restart needed; RunOnce set"
    ${Else}
      StrCpy $Result "W-WSL"
      StrCpy $Why "no Debian or Ubuntu distribution in WSL answers"
      StrCpy $StepWSL "failed: $Why"
    ${EndIf}
    Goto done
  ${EndIf}
  Call WslVersion

  ; the Linux user and the packages, as root (nothing asked)
  DetailPrint "Getting $Distro ready"
  ${If} $PUid == 0
    StrCpy $3 '--win-user "$WinUser"'
  ${Else}
    StrCpy $3 "--user $PUser"
  ${EndIf}
  nsExec::ExecToStack /TIMEOUT=1800000 '"$Wsl" -d $Distro -u root --cd "$INSTDIR" -e bash ./wsl-bootstrap.sh --setup --out . $3'
  Pop $1
  Pop $0
  ReadINIStr $0 "$INSTDIR\setup.ini" "setup" "result"
  ReadINIStr $LUser "$INSTDIR\setup.ini" "setup" "user"
  ReadINIStr $2 "$INSTDIR\setup.ini" "setup" "made"
  ReadINIStr $HaveModel "$INSTDIR\setup.ini" "setup" "model"
  ${Log} "setup in $Distro: exit $1, result $0, user $LUser"
  ${If} $0 != "ok"
  ${OrIf} $LUser == ""
    ReadINIStr $Why "$INSTDIR\setup.ini" "setup" "why"
    ${If} $Why == ""
      StrCpy $Why "the setup inside $Distro stopped (exit $1)"
    ${EndIf}
    StrCpy $Result "W-WSL"
    StrCpy $StepWSL "failed: $Why"
    Goto done
  ${EndIf}
  ${If} $2 == 1
    ; a new Linux user: also the default one for WSL (best effort; wsl.conf already says so)
    nsExec::ExecToStack /TIMEOUT=60000 '"$Wsl" --manage $Distro --set-default-user $LUser'
    Pop $1
    Pop $0
    ${If} ${FileExists} "$LOCALAPPDATA\Microsoft\WindowsApps\ubuntu.exe"
    ${AndIf} $Distro == "Ubuntu"
      nsExec::ExecToStack /TIMEOUT=60000 '"$LOCALAPPDATA\Microsoft\WindowsApps\ubuntu.exe" config --default-user $LUser'
      Pop $1
      Pop $0
    ${EndIf}
  ${EndIf}
  WriteINIStr "$INSTDIR\wsl.ini" "wsl" "distro" "$Distro"
  WriteINIStr "$INSTDIR\wsl.ini" "wsl" "user" "$LUser"
  StrCpy $StepWSL "ok: $Distro, Linux user $LUser"
  done:
  SetAutoClose true
SectionEnd

; ---------------------------------------------------------------------------------------------- pages
Function HideBack
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
FunctionEnd

Function RestartShow
  ${If} $NeedRestart != 1
    Abort
  ${EndIf}
  ${Log} "page: restart"
  Call WriteReport
  !insertmacro MUI_HEADER_TEXT "Restart Windows" "WSL is installed."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 20u "Windows must restart to finish installing WSL."
  Pop $1
  SendMessage $1 ${WM_SETFONT} $FontBig 1
  ${NSD_CreateLabel} 0 28u 100% 12u "Setup goes on by itself after the restart."
  Pop $1
  Call HideBack
  GetDlgItem $1 $HWNDPARENT 1
  SendMessage $1 ${WM_SETTEXT} 0 "STR:Restart now"
  GetDlgItem $1 $HWNDPARENT 2
  SendMessage $1 ${WM_SETTEXT} 0 "STR:Later"
  nsDialogs::Show
FunctionEnd

Function RestartLeave
  ${Log} "restart now"
  Reboot
FunctionEnd

Function AddressShow
  ${If} $Result != ""
  ${OrIf} $NeedRestart == 1
    Abort
  ${EndIf}
  ${Log} "page: address"
  !insertmacro MUI_HEADER_TEXT "Trunk address" "Where this PC joins your tree."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 12u "Trunk address"
  Pop $1
  ${NSD_CreateText} 0 14u 100% 14u "$Trunk"
  Pop $hAddr
  ${NSD_SetFocus} $hAddr
  Call HideBack
  GetDlgItem $1 $HWNDPARENT 1
  ${If} $HaveModel == 1
    SendMessage $1 ${WM_SETTEXT} 0 "STR:Connect"
  ${Else}
    SendMessage $1 ${WM_SETTEXT} 0 "STR:Next >"
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function AddressLeave
  ${NSD_GetText} $hAddr $0
  ; no blanks around it, no trailing /
  trim:
    StrCpy $1 $0 1
    ${If} $1 == " "
      StrCpy $0 $0 "" 1
      Goto trim
    ${EndIf}
    StrCpy $1 $0 1 -1
    ${If} $1 == " "
    ${OrIf} $1 == "/"
      StrCpy $0 $0 -1
      Goto trim
    ${EndIf}
  ; https:// or http://, then only the characters join.sh takes
  StrCpy $2 0
  StrCpy $1 $0 8
  ${If} $1 == "https://"
    StrCpy $2 1
  ${EndIf}
  StrCpy $1 $0 7
  ${If} $1 == "http://"
    StrCpy $2 1
  ${EndIf}
  StrLen $1 $0
  ${If} $1 < 10
    StrCpy $2 0
  ${EndIf}
  StrCpy $3 0
  ${DoWhile} $2 = 1
    StrCpy $4 $0 1 $3
    ${If} $4 == ""
      ${ExitDo}
    ${EndIf}
    StrCpy $5 0
    StrCpy $7 0
    ${Do}
      StrCpy $6 "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:/._~%@+-" 1 $5
      ${If} $6 == ""
        ${ExitDo}
      ${EndIf}
      ${If} $6 S== $4
        StrCpy $7 1
        ${ExitDo}
      ${EndIf}
      IntOp $5 $5 + 1
    ${Loop}
    ${If} $7 = 0
      StrCpy $2 0
    ${EndIf}
    IntOp $3 $3 + 1
  ${Loop}
  ${If} $2 = 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "The address starts with https://, like https://trunk.example.org (your trunk, what your phone uses)"
    Abort
  ${EndIf}
  StrCpy $Trunk $0
  WriteINIStr "$INSTDIR\wsl.ini" "wsl" "trunk" "$Trunk"
  Call UrlHost
  StrCpy $StepAddr "$0"
  ${Log} "trunk: $0"
FunctionEnd

; step 3b (decision L15, revised): the model step — the same choices and the same words as join.sh on Linux and
; macOS. Shown only when this PC's root has no model yet. "Same as the home root" (the default) writes nothing:
; join.sh then asks the home root for its model once the phone has approved. A provider asks only its key (its
; address and kind are filled in; its default model is shown and can be changed); Other asks address, kind,
; model, key. The key is typed into a hidden field, written only to upstream.env (wsl-bootstrap.sh moves it into
; WSL at once and removes it here), never shown again and never logged.
Function PresetOf ; $R0 a provider's label -> $R1 address, $R2 kind, $R4 models (default first); $R5 same|preset|other
  StrCpy $R1 ""
  StrCpy $R2 ""
  StrCpy $R4 ""
  StrCpy $R5 "preset"
  ${If} $R0 == "${P_SAME_LABEL}"
    StrCpy $R5 "same"
  ${ElseIf} $R0 == "${P_ZAI_LABEL}"
    StrCpy $R1 "${P_ZAI_URL}"
    StrCpy $R2 "${P_ZAI_STYLE}"
    StrCpy $R4 "${P_ZAI_MODELS}"
  ${ElseIf} $R0 == "${P_OPENROUTER_LABEL}"
    StrCpy $R1 "${P_OPENROUTER_URL}"
    StrCpy $R2 "${P_OPENROUTER_STYLE}"
    StrCpy $R4 "${P_OPENROUTER_MODELS}"
  ${ElseIf} $R0 == "${P_ANTHROPIC_LABEL}"
    StrCpy $R1 "${P_ANTHROPIC_URL}"
    StrCpy $R2 "${P_ANTHROPIC_STYLE}"
    StrCpy $R4 "${P_ANTHROPIC_MODELS}"
  ${ElseIf} $R0 == "${P_OPENAI_LABEL}"
    StrCpy $R1 "${P_OPENAI_URL}"
    StrCpy $R2 "${P_OPENAI_STYLE}"
    StrCpy $R4 "${P_OPENAI_MODELS}"
  ${Else}
    StrCpy $R5 "other"
  ${EndIf}
FunctionEnd

Function FillModels ; $R4 "a b c" -> the provider model box's list; $R3 the first (the default)
  SendMessage $hPModel ${CB_RESETCONTENT} 0 0
  StrCpy $R3 ""
  StrCpy $R6 ""
  StrCpy $R7 0
  ${Do}
    StrCpy $R8 $R4 1 $R7
    ${If} $R8 == " "
    ${OrIf} $R8 == ""
      ${If} $R6 != ""
        ${NSD_CB_AddString} $hPModel "$R6"
        ${If} $R3 == ""
          StrCpy $R3 $R6
        ${EndIf}
        StrCpy $R6 ""
      ${EndIf}
      ${If} $R8 == ""
        ${ExitDo}
      ${EndIf}
    ${Else}
      StrCpy $R6 "$R6$R8"
    ${EndIf}
    IntOp $R7 $R7 + 1
  ${Loop}
  ${NSD_SetText} $hPModel "$R3"
FunctionEnd

Function ModelProvApply ; show the fields of the chosen provider
  ${NSD_GetText} $hProv $R0
  Call PresetOf
  StrCpy $R6 ${SW_HIDE}
  StrCpy $R7 ${SW_HIDE}
  ${If} $R5 == "preset"
    StrCpy $R6 ${SW_SHOW}
  ${ElseIf} $R5 == "other"
    StrCpy $R7 ${SW_SHOW}
  ${EndIf}
  ShowWindow $hPKeyLbl $R6
  ShowWindow $hPKey $R6
  ShowWindow $hPModelLbl $R6
  ShowWindow $hPModel $R6
  ShowWindow $hOAddrLbl $R7
  ShowWindow $hUpUrl $R7
  ShowWindow $hOKindLbl $R7
  ShowWindow $hUpKind $R7
  ShowWindow $hOModelLbl $R7
  ShowWindow $hUpModel $R7
  ShowWindow $hOKeyLbl $R7
  ShowWindow $hUpKey $R7
  ShowWindow $hOHint $R7
  ${If} $R5 == "preset"
    SendMessage $hPKeyLbl ${WM_SETTEXT} 0 "STR:$R0 API key"
    Call FillModels
  ${EndIf}
FunctionEnd

Function ModelProvChange
  Pop $R9
  Call ModelProvApply
FunctionEnd

Function ModelShow
  ${If} $Result != ""
  ${OrIf} $NeedRestart == 1
  ${OrIf} $HaveModel == 1
    Abort
  ${EndIf}
  ${Log} "page: model"
  !insertmacro MUI_HEADER_TEXT "Model" " "
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 2u 68u 12u "Model provider"
  Pop $1
  ${NSD_CreateDropList} 72u 0 150u 90u ""
  Pop $hProv
  ${NSD_CB_AddString} $hProv "${P_SAME_LABEL}"
  ${NSD_CB_AddString} $hProv "${P_ZAI_LABEL}"
  ${NSD_CB_AddString} $hProv "${P_OPENROUTER_LABEL}"
  ${NSD_CB_AddString} $hProv "${P_ANTHROPIC_LABEL}"
  ${NSD_CB_AddString} $hProv "${P_OPENAI_LABEL}"
  ${NSD_CB_AddString} $hProv "${P_OTHER_LABEL}"
  ${NSD_CB_SelectString} $hProv "${P_SAME_LABEL}"
  ${NSD_OnChange} $hProv ModelProvChange
  ; a provider: its key, then its model
  ${NSD_CreateLabel} 0 26u 68u 12u "API key"
  Pop $hPKeyLbl
  ${NSD_CreatePassword} 72u 24u 228u 13u ""
  Pop $hPKey
  ${NSD_CreateLabel} 0 48u 68u 12u "Model"
  Pop $hPModelLbl
  ${NSD_CreateComboBox} 72u 46u 150u 70u ""
  Pop $hPModel
  ; Other: address, kind, model, key
  ${NSD_CreateLabel} 0 26u 68u 12u "Address"
  Pop $hOAddrLbl
  ${NSD_CreateText} 72u 24u 228u 13u ""
  Pop $hUpUrl
  ${NSD_CreateLabel} 0 48u 68u 12u "Kind"
  Pop $hOKindLbl
  ${NSD_CreateDropList} 72u 46u 90u 60u ""
  Pop $hUpKind
  ${NSD_CB_AddString} $hUpKind "openai"
  ${NSD_CB_AddString} $hUpKind "anthropic"
  ${NSD_CB_SelectString} $hUpKind "openai"
  ${NSD_CreateLabel} 0 70u 68u 12u "Model"
  Pop $hOModelLbl
  ${NSD_CreateText} 72u 68u 228u 13u ""
  Pop $hUpModel
  ${NSD_CreateLabel} 0 92u 68u 12u "Key"
  Pop $hOKeyLbl
  ${NSD_CreatePassword} 72u 90u 228u 13u ""
  Pop $hUpKey
  ${NSD_CreateLabel} 72u 106u 228u 12u "Empty for a model on your own network."
  Pop $hOHint
  Call ModelProvApply
  ${NSD_SetFocus} $hProv
  Call HideBack
  GetDlgItem $1 $HWNDPARENT 1
  SendMessage $1 ${WM_SETTEXT} 0 "STR:Connect"
  nsDialogs::Show
FunctionEnd

Function TrunkFromExeDir ; the folder this exe was saved into (the trunk's download page names it) -> $Trunk
  ; $EXEDIR is like C:\Users\me\Downloads\ljoolq.veraldar.org (the browser names the folder after the
  ; link it followed). Take the LAST path segment; if it looks like a host name (letters, digits, dots,
  ; dashes, at least one dot), the trunk is https://<it>. Anything else: no guess (the address page asks).
  StrCpy $0 $EXEDIR
  StrCpy $1 ""
  rd:
    StrCpy $2 $0 1 -1
    ${If} $2 == "\\"
      StrCpy $1 $0 "" -1
      Goto rdone
    ${EndIf}
    StrCpy $0 $0 -1
    ${If} $0 == ""
      StrCpy $1 ""
      Goto rdone
    ${EndIf}
    StrLen $3 $0
    ${If} $3 > 200
      Goto rdone
    ${EndIf}
    Goto rd
  rdone:
  StrCpy $1 $1 "" 1
  ${If} $1 == ""
    StrCpy $1 $EXEDIR
  ${EndIf}
  ; $1 = the last segment (maybe with the .exe tail already cut by the \\ split; also drop a trailing
  ; "Veraldar-Setup-x.y.z.exe" style file name if $EXEDIR pointed at a file-less path)
  StrCpy $2 0
  ok:
    StrCpy $3 $1 1 $2
    ${If} $3 == ""
      Goto okdone
    ${EndIf}
    ${If} $3 == "."
    ${OrIf} $3 == "-"
    ${OrIf} $3 S== $3
      IntOp $2 $2 + 1
      Goto ok
    ${EndIf}
    StrCpy $1 ""
  okdone:
  ${If} $1 != ""
    StrLen $2 $1
    ${If} $2 > 1
      StrCpy $2 $1 1
      ${If} $2 == "-"
        StrCpy $1 ""
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $1 != ""
    Push $1
    Call IsHostName
    Pop $2
    ${If} $2 == 1
      StrCpy $Trunk "https://$1"
      ${Log} "trunk from the download folder: $Trunk"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function IsHostName ; $1 on the stack -> 1 when it looks like a DNS host (dot, and only [A-Za-z0-9.-])
  Exch $1
  Push $2
  Push $3
  StrCpy $2 0
  StrCpy $3 0   ; dots seen
  hn:
    StrCpy $4 $1 1 $2
    ${If} $4 == ""
      Goto hndone
    ${EndIf}
    ${If} $4 == "."
      IntOp $3 $3 + 1
    ${Else}
      StrCpy $5 "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-"
      StrCpy $6 0
      hfind:
        StrCpy $7 $5 1 $6
        ${If} $7 == ""
          StrCpy $2 -1
          Goto hndone
        ${EndIf}
        ${If} $7 S== $4
          Goto hnext
        ${EndIf}
        IntOp $6 $6 + 1
        Goto hfind
    ${EndIf}
    hnext:
      IntOp $2 $2 + 1
      Goto hn
  hndone:
  ${If} $2 == -1
    StrCpy $1 0
  ${ElseIf} $3 < 1
    StrCpy $1 0
  ${ElseIf} $2 < 4
    StrCpy $1 0
  ${Else}
    StrCpy $1 1
  ${EndIf}
  Pop $3
  Pop $2
  Exch $1
FunctionEnd

Function UrlHost ; $0 an http(s):// address -> $0 its host[:port] only (what is logged: no user:pass@, no path, no ?key=)
  StrCpy $1 $0 8
  ${If} $1 == "https://"
    StrCpy $0 $0 "" 8
  ${Else}
    StrCpy $0 $0 "" 7
  ${EndIf}
  StrCpy $2 0
  ${Do}
    StrCpy $1 $0 1 $2
    ${If} $1 == ""
    ${OrIf} $1 == "/"
    ${OrIf} $1 == "?"
    ${OrIf} $1 == "#"
      ${ExitDo}
    ${EndIf}
    IntOp $2 $2 + 1
  ${Loop}
  StrCpy $0 $0 $2
  StrLen $2 $0
  ${DoWhile} $2 > 0
    IntOp $2 $2 - 1
    StrCpy $1 $0 1 $2
    ${If} $1 == "@"
      IntOp $2 $2 + 1
      StrCpy $0 $0 "" $2
      ${ExitDo}
    ${EndIf}
  ${Loop}
FunctionEnd

Function TrimBlanks ; $0 without blanks around it
  trim:
    StrCpy $1 $0 1
    ${If} $1 == " "
      StrCpy $0 $0 "" 1
      Goto trim
    ${EndIf}
    StrCpy $1 $0 1 -1
    ${If} $1 == " "
      StrCpy $0 $0 -1
      Goto trim
    ${EndIf}
FunctionEnd

Function ModelLeave
  ${NSD_GetText} $hProv $R0
  Call PresetOf
  ${If} $R5 == "same"
    Delete "$INSTDIR\upstream.env"
    StrCpy $StepModel "same as the home root"
    ${Log} "model: same as the home root"
    Return
  ${EndIf}
  ${If} $R5 == "preset"
    StrCpy $5 $R1
    StrCpy $6 $R2
    ${NSD_GetText} $hPModel $0
    Call TrimBlanks
    StrCpy $7 $0
    ${If} $7 == ""
      Call FillModels
      StrCpy $7 $R3
    ${EndIf}
    ${NSD_GetText} $hPKey $0
    Call TrimBlanks
    ${If} $0 == ""
      MessageBox MB_ICONEXCLAMATION|MB_OK "The $R0 API key is needed."
      Abort
    ${EndIf}
  ${Else}
    ${NSD_GetText} $hUpUrl $0
    Call TrimBlanks
    StrCpy $5 $0
    StrCpy $1 $5 8
    StrCpy $2 $5 7
    StrLen $3 $5
    ${If} $1 != "https://"
    ${AndIf} $2 != "http://"
      StrCpy $3 0
    ${EndIf}
    ${If} $3 < 10
      MessageBox MB_ICONEXCLAMATION|MB_OK "The address starts with https:// (or http:// for a model on your own network)."
      Abort
    ${EndIf}
    ${NSD_GetText} $hUpKind $6
    ${If} $6 != "anthropic"
      StrCpy $6 "openai"
    ${EndIf}
    ${NSD_GetText} $hUpModel $0
    Call TrimBlanks
    StrCpy $7 $0
    ${If} $7 == ""
      MessageBox MB_ICONEXCLAMATION|MB_OK "Which model?"
      Abort
    ${EndIf}
    ${NSD_GetText} $hUpKey $0
    Call TrimBlanks
  ${EndIf}
  ClearErrors
  FileOpen $9 "$INSTDIR\upstream.env" w
  ${If} ${Errors}
    StrCpy $0 ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "Setup could not write to $INSTDIR."
    Abort
  ${EndIf}
  FileWrite $9 "YGG_UPSTREAM_BASE_URL=$5$\n"
  FileWrite $9 "YGG_UPSTREAM_STYLE=$6$\n"
  FileWrite $9 "YGG_UPSTREAM_MODEL=$7$\n"
  FileWrite $9 "YGG_UPSTREAM_API_KEY=$0$\n"
  FileClose $9
  ${If} $0 == ""
    StrCpy $8 "no key"
  ${Else}
    StrCpy $8 "a key"
  ${EndIf}
  StrCpy $0 ""
  ${NSD_SetText} $hUpKey ""
  ${NSD_SetText} $hPKey ""
  StrCpy $0 $5
  Call UrlHost
  StrCpy $StepModel "$R0: $0, $6, $8"
  ${Log} "model: $R0 ($0, $6), $8"
FunctionEnd

Function JoinShow
  ${If} $Result != ""
  ${OrIf} $NeedRestart == 1
    Abort
  ${EndIf}
  ${Log} "page: join"
  !insertmacro MUI_HEADER_TEXT "Approve on your phone" "This PC asks your tree to let it in."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 24u "Connecting to $Trunk. The first time takes a few minutes."
  Pop $hWait
  ${NSD_CreateProgressBar} 0 30u 100% 10u ""
  Pop $hBar
  ${NSD_AddStyle} $hBar ${PBS_MARQUEE}
  SendMessage $hBar ${PBM_SETMARQUEE} 1 50
  ${NSD_CreateBitmap} 0 0 140u 130u ""
  Pop $hQR
  ShowWindow $hQR ${SW_HIDE}
  ${NSD_CreateLabel} 150u 2u 150u 26u "Approve this on your phone"
  Pop $hTitle
  SendMessage $hTitle ${WM_SETFONT} $FontBig 1
  ShowWindow $hTitle ${SW_HIDE}
  ${NSD_CreateLabel} 150u 34u 150u 32u ""
  Pop $hCode
  SendMessage $hCode ${WM_SETFONT} $FontCode 1
  ShowWindow $hCode ${SW_HIDE}
  ${NSD_CreateLabel} 150u 76u 150u 40u "Scan the code, check the phone shows the same letters, approve."
  Pop $hHint
  ShowWindow $hHint ${SW_HIDE}
  Call HideBack
  GetDlgItem $1 $HWNDPARENT 1
  EnableWindow $1 0

  ; step 4: wsl-bootstrap.sh -> the embedded join.sh, hidden; it writes status.ini, this page reads it
  Delete "$INSTDIR\status.ini"
  Delete "$INSTDIR\join-qr.bmp"
  StrCpy $CodeShown 0
  StrCpy $Ended 0
  StrCpy $1 '"$Wsl" -d $Distro -u $LUser --cd "$INSTDIR" -e bash ./wsl-bootstrap.sh --hub $Trunk --name $CompName --out .'
  Call StartHidden
  StrCpy $JoinProc $4
  ${If} $JoinProc == 0
    ${Log} "join: wsl.exe did not start (error $5)"
  ${Else}
    ${Log} "join: started in $Distro as $LUser, --name $CompName"
  ${EndIf}
  System::Call 'kernel32::GetTickCount() i .r0'
  StrCpy $JoinStart $0
  ${NSD_CreateTimer} JoinTick 500
  nsDialogs::Show
FunctionEnd

Function CancelJoin ; stop the join inside WSL and wsl.exe here
  ${If} $JoinProc != 0
    nsExec::ExecToStack /TIMEOUT=30000 '"$Wsl" -d $Distro -u $LUser --cd "$INSTDIR" -e bash ./wsl-bootstrap.sh --cancel'
    Pop $0
    Pop $0
    System::Call 'kernel32::TerminateProcess(p $JoinProc, i 1)'
    System::Call 'kernel32::CloseHandle(p $JoinProc)'
    StrCpy $JoinProc 0
    ${Log} "join: stopped"
  ${EndIf}
FunctionEnd

Function JoinTick
  ${If} $Ended == 1
    Return
  ${EndIf}
  ${If} $JoinProc == 0
    StrCpy $JoinRc -1
    Goto ended
  ${EndIf}
  ReadINIStr $0 "$INSTDIR\status.ini" "join" "state"
  ${If} $0 == "code"
  ${AndIf} $CodeShown != 1
    StrCpy $CodeShown 1
    System::Call 'kernel32::GetTickCount() i .r1'
    StrCpy $CodeTick $1
    ReadINIStr $1 "$INSTDIR\status.ini" "join" "code"
    ReadINIStr $2 "$INSTDIR\status.ini" "join" "qr"
    ${Log} "join: the code is up"
    ShowWindow $hWait ${SW_HIDE}
    ShowWindow $hBar ${SW_HIDE}
    ${NSD_SetText} $hCode "$1"
    ${If} $2 != ""
    ${AndIf} ${FileExists} "$INSTDIR\$2"
      ${NSD_SetImage} $hQR "$INSTDIR\$2" $hQRImg
      ShowWindow $hQR ${SW_SHOW}
    ${Else}
      ${NSD_SetText} $hHint "Open your tree on the phone and approve this code."
    ${EndIf}
    ShowWindow $hTitle ${SW_SHOW}
    ShowWindow $hCode ${SW_SHOW}
    ShowWindow $hHint ${SW_SHOW}
  ${EndIf}
  System::Call 'kernel32::WaitForSingleObject(p $JoinProc, i 0) i .r0'
  ${If} $0 = 0
    System::Call 'kernel32::GetExitCodeProcess(p $JoinProc, *i .r1) i .r0'
    StrCpy $JoinRc $1
    System::Call 'kernel32::CloseHandle(p $JoinProc)'
    StrCpy $JoinProc 0
    Goto ended
  ${EndIf}
  System::Call 'kernel32::GetTickCount() i .r0'
  ${If} $CodeShown == 1
    IntOp $1 $0 - $CodeTick
    ${If} $1 > ${QR_WAIT_MS}
      Call CancelJoin
      StrCpy $Result "W-JOIN"
      StrCpy $Why "no approval within 10 minutes"
      StrCpy $JoinRc 4
      Goto ended
    ${EndIf}
  ${Else}
    IntOp $1 $0 - $JoinStart
    ${If} $1 > ${PREP_WAIT_MS}
      Call CancelJoin
      StrCpy $Result "W-NET"
      StrCpy $Why "no join code after 40 minutes"
      StrCpy $JoinRc -2
      Goto ended
    ${EndIf}
  ${EndIf}
  Return
  ended:
  StrCpy $Ended 1
  ${NSD_KillTimer} JoinTick
  Call JoinEnded
  GetDlgItem $1 $HWNDPARENT 1
  EnableWindow $1 1
  SendMessage $HWNDPARENT 0x408 1 0   ; on to the last page
FunctionEnd

Function JoinEnded ; steps 5-6: what happened, and on approval the start-at-login entry + the root started
  ReadINIStr $0 "$INSTDIR\status.ini" "join" "state"
  ReadINIStr $1 "$INSTDIR\status.ini" "join" "step"
  ReadINIStr $2 "$INSTDIR\status.ini" "join" "why"
  ${Log} "join: wsl.exe exit $JoinRc, state $0, step $1"
  ${If} $Result == ""
    ${If} $JoinRc == 0
    ${AndIf} $0 == "done"
      StrCpy $Result ""
    ${ElseIf} $1 != ""
      StrCpy $Result $1
      StrCpy $Why $2
    ${ElseIf} $JoinRc == 5
      StrCpy $Result "W-RUN"
    ${ElseIf} $0 == ""
      StrCpy $Result "W-WSL"
      StrCpy $Why "WSL did not run the join (wsl.exe exit $JoinRc)"
    ${Else}
      StrCpy $Result "W-JOIN"
      StrCpy $Why "the join stopped (exit $JoinRc)"
    ${EndIf}
  ${EndIf}
  ${If} $Result == ""
    StrCpy $StepJoin "approved on the phone"
  ${ElseIf} $Result == "W-RUN"
    StrCpy $StepJoin "approved on the phone"
  ${Else}
    StrCpy $StepJoin "$Result: $Why"
  ${EndIf}
  ${If} $Result == ""
  ${OrIf} $Result == "W-RUN"
    ; joined: start at every logon, and now (keepalive.vbs -> launcher.bat -> bin/start --hold, no window)
    WriteINIStr "$INSTDIR\wsl.ini" "wsl" "name" "$CompName"
    CreateShortcut "$SMSTARTUP\Veraldar.lnk" "$WINDIR\System32\wscript.exe" '//B //Nologo "$INSTDIR\keepalive.vbs"'
    Exec '"$WINDIR\System32\wscript.exe" //B //Nologo "$INSTDIR\keepalive.vbs"'
    ${If} $Result == ""
      StrCpy $StepRun "running; starts at every logon (Startup: Veraldar)"
    ${Else}
      StrCpy $StepRun "W-RUN: $Why; start-at-login entry installed"
    ${EndIf}
    ${Log} "start-at-login entry installed, root started"
  ${EndIf}
FunctionEnd

Function DoneShow
  Delete "$INSTDIR\upstream.env"   ; (wsl-bootstrap.sh removes it when it takes it; never left behind)
  ${If} $NeedRestart == 1
    Abort
  ${EndIf}
  DeleteRegValue HKCU "${RUNONCE_KEY}" "Veraldar"
  StrCpy $AtEnd 1
  ${Log} "page: done $Result"
  Call WriteReport
  StrCpy $3 "Not connected"
  StrCpy $4 ""
  StrCpy $5 "Run Setup again to try once more."
  ${If} $Result == ""
    StrCpy $3 "Connected"
    StrCpy $4 "Connected as $CompName."
    StrCpy $5 "Veraldar runs in the background and starts when you log on."
  ${ElseIf} $Result == "W-WSL"
    StrCpy $4 "WSL could not be set up on this PC."
    StrCpy $5 "Restart Windows, then run Setup again."
  ${ElseIf} $Result == "W-NET"
    StrCpy $4 "Could not reach the trunk or download Veraldar."
    StrCpy $5 "Check the internet connection and the address, then run Setup again."
  ${ElseIf} $Result == "W-SIG"
    StrCpy $4 "The download failed its signature check. Nothing was installed."
  ${ElseIf} $Result == "W-MODEL"
    StrCpy $4 "This PC has no model to think with yet."
    StrCpy $5 "Run Setup again and choose a model provider."
  ${ElseIf} $Result == "W-RUN"
    StrCpy $3 "Joined, not running"
    StrCpy $4 "$CompName joined your tree, but Veraldar did not start."
    StrCpy $5 "Restart Windows. It starts when you log on."
  ${ElseIf} $JoinRc == 3
    StrCpy $4 "The phone said no. Nothing was installed."
  ${ElseIf} $JoinRc == 4
    StrCpy $4 "Nobody approved within 10 minutes."
    StrCpy $5 "Run Setup again for a new code."
  ${Else}
    StrCpy $4 "The trunk did not let this PC in."
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$3" " "
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 30u "$4"
  Pop $1
  SendMessage $1 ${WM_SETFONT} $FontBig 1
  ${NSD_CreateLabel} 0 36u 100% 24u "$5"
  Pop $1
  ${If} $Result != ""
    ${NSD_CreateLabel} 0 100u 100% 12u "Step code: $Result"
    Pop $1
    ${NSD_CreateLabel} 0 114u 100% 12u "Details: $INSTDIR\install-report.txt"
    Pop $1
  ${EndIf}
  Call HideBack
  GetDlgItem $1 $HWNDPARENT 1
  SendMessage $1 ${WM_SETTEXT} 0 "STR:Close"
  EnableWindow $1 1
  GetDlgItem $1 $HWNDPARENT 2
  ShowWindow $1 ${SW_HIDE}
  nsDialogs::Show
FunctionEnd

Function OnUserAbort
  Delete "$INSTDIR\upstream.env"
  ${If} $AtEnd == 1
    Return
  ${EndIf}
  ${If} $JoinProc != 0
    ${NSD_KillTimer} JoinTick
    StrCpy $Ended 1
    Call CancelJoin
    StrCpy $Result "W-JOIN"
    StrCpy $Why "cancelled in Setup"
    StrCpy $StepJoin "cancelled in Setup"
  ${EndIf}
  ${If} $NeedRestart != 1
    ${Log} "cancelled"
    ${If} $Result == ""
      StrCpy $Result "W-JOIN"
      StrCpy $Why "cancelled in Setup"
    ${EndIf}
  ${EndIf}
  Call WriteReport
FunctionEnd

Function .onInit
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "VeraldarSetup") p .r0 ?e'
  Pop $1
  ${If} $1 = 183
    Quit   ; already running
  ${EndIf}
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/continue" $1
  ${IfNot} ${Errors}
    StrCpy $Continue 1
  ${EndIf}
  CreateDirectory "$INSTDIR"
  Delete "$INSTDIR\upstream.env"   ; (a Setup that was killed between the model page and the join leaves none behind)
  ${If} $Continue != 1
    Delete "$INSTDIR\setup.old.log"
    Rename "$INSTDIR\setup.log" "$INSTDIR\setup.old.log"
  ${EndIf}
  Call FindWsl
  System::Call 'kernel32::SetEnvironmentVariableW(w "WSL_UTF8", w "1")'
  ReadEnvStr $WinUser USERNAME
  ReadEnvStr $CompName COMPUTERNAME
  ReadINIStr $Trunk "$INSTDIR\wsl.ini" "wsl" "trunk"
  ${If} $Trunk == ""
    StrCpy $Trunk "${TRUNK_DEFAULT}"
  ${EndIf}
  ${If} $Trunk == ""
    Call TrunkFromExeDir
  ${EndIf}
  StrCpy $JoinProc 0
  CreateFont $FontBig "Segoe UI" 12 600
  CreateFont $FontCode "Segoe UI" 26 700
  Call DescribeWindows
  ${Log} "Veraldar-Setup ${APPVERSION}$\r$\n[setup] $WinDesc$\r$\n[setup] continue after restart: $Continue"

  ; ---- step 1: Windows 10 2004 (build 19041) or newer, 11, on x86_64
  ${WinVerGetBuild} $0
  ${If} ${AtLeastWin10}
  ${AndIf} $0 >= 19041
  ${AndIf} ${IsNativeAMD64}
    StrCpy $StepOS "ok: $WinDesc"
  ${Else}
    StrCpy $StepOS "no: $WinDesc"
    StrCpy $Result "W-OS"
    StrCpy $Why "needs Windows 10 build 19041 or newer / Windows 11, x86_64"
    ${Log} "W-OS: $WinDesc"
    Call WriteReport
    MessageBox MB_ICONSTOP|MB_OK "Veraldar needs 64-bit Windows 10 (version 2004 or newer) or Windows 11."
    Quit
  ${EndIf}
FunctionEnd

; ------------------------------------------------------------------------------------------- uninstall
Function un.onInit
  Call un.FindWsl
  ReadINIStr $Distro "$INSTDIR\wsl.ini" "wsl" "distro"
  ReadINIStr $LUser "$INSTDIR\wsl.ini" "wsl" "user"
  ReadINIStr $Name "$INSTDIR\wsl.ini" "wsl" "name"
  ${If} $Name == ""
    ReadEnvStr $Name COMPUTERNAME
  ${EndIf}
  CreateFont $FontBig "Segoe UI" 12 600
FunctionEnd

Function un.ConfirmShow
  !insertmacro MUI_HEADER_TEXT "Remove Veraldar" " "
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 20u "Veraldar stops on this PC and is removed."
  Pop $1
  SendMessage $1 ${WM_SETFONT} $FontBig 1
  ${NSD_CreateLabel} 0 28u 100% 12u "Ubuntu and its files stay."
  Pop $1
  GetDlgItem $1 $HWNDPARENT 1
  SendMessage $1 ${WM_SETTEXT} 0 "STR:Remove"
  nsDialogs::Show
FunctionEnd

Section "Uninstall"
  ; stop the root inside WSL (its services and the keepalive's hold); the distribution and its files stay
  ${If} $Distro != ""
  ${AndIf} $LUser != ""
    DetailPrint "Stopping Veraldar"
    nsExec::ExecToStack /TIMEOUT=60000 '"$Wsl" -d $Distro -u $LUser --cd "$INSTDIR" -e bash ./root.sh --stop'
    Pop $0
    Pop $0
  ${EndIf}
  Delete "$SMSTARTUP\Veraldar.lnk"
  DeleteRegValue HKCU "${RUNONCE_KEY}" "Veraldar"
  Delete "$INSTDIR\wsl-bootstrap.sh"
  Delete "$INSTDIR\root.sh"
  Delete "$INSTDIR\launcher.bat"
  Delete "$INSTDIR\keepalive.vbs"
  Delete "$INSTDIR\Veraldar-Setup.exe"
  Delete "$INSTDIR\wsl.ini"
  Delete "$INSTDIR\status.ini"
  Delete "$INSTDIR\setup.ini"
  Delete "$INSTDIR\join-qr.bmp"
  Delete "$INSTDIR\setup.log"
  Delete "$INSTDIR\setup.old.log"
  Delete "$INSTDIR\install-report.txt"
  Delete "$INSTDIR\upstream.env"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  SetAutoClose true
SectionEnd

Function un.DoneShow
  !insertmacro MUI_HEADER_TEXT "Veraldar is removed" " "
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 30u "One more step: on your phone, open the roots sheet and remove $Name."
  Pop $1
  SendMessage $1 ${WM_SETFONT} $FontBig 1
  GetDlgItem $1 $HWNDPARENT 1
  SendMessage $1 ${WM_SETTEXT} 0 "STR:Close"
  GetDlgItem $1 $HWNDPARENT 2
  ShowWindow $1 ${SW_HIDE}
  GetDlgItem $1 $HWNDPARENT 3
  ShowWindow $1 ${SW_HIDE}
  nsDialogs::Show
FunctionEnd
