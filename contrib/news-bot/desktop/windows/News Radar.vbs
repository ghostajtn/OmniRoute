' News Radar launcher. Starts the program without a console window, waits for it to end,
' and tells you if it stopped unexpectedly. Closing the News Radar window ends the program.
Option Explicit

Dim shell, fso, here, node, server, q, cmdline, rc
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
node = here & "\node\node.exe"
server = here & "\program\desktop\server.mjs"
q = Chr(34)

' cmd expands %LOCALAPPDATA% and gives the program a (discarded) console to print to.
' Settings, saved news and the log live in that data folder, apart from the program,
' so updating or reinstalling keeps them. The program creates the folder itself.
cmdline = "cmd /c " & q & q & node & q & " " & q & server & q & " " & q & "%LOCALAPPDATA%\NewsRadar\data" & q & " >nul 2>&1" & q
rc = shell.Run(cmdline, 0, True)

If rc <> 0 Then
  MsgBox "News Radar stopped unexpectedly." & vbCrLf & vbCrLf & "The reason is in the file news-radar.log in this folder:" & vbCrLf & "%LOCALAPPDATA%\NewsRadar\data" & vbCrLf & "(type that into the File Explorer address bar)", vbExclamation, "News Radar"
End If
