' keepalive.vbs - keeps this PC's root running: runs launcher.bat without a window (it starts the root
' inside WSL and holds WSL open). Run at every logon (Startup: "Veraldar") and by the installer right
' after the phone approved. Does nothing before this PC has joined.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & dir & "\launcher.bat""", 0, False
