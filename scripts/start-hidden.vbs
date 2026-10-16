' Starts the radar server with no console window, for the logon scheduled task.
'
' Task Scheduler runs a console app in your session with a visible window when
' the task's logon type is Interactive, so a plain node.exe task leaves a
' terminal open -- closing it kills the server. This runs the server hidden
' instead.
'
' bWaitOnReturn is True so the task stays in the "Running" state: that keeps
' the task's own "do not start a second instance" setting meaningful and lets
' it be stopped from Task Scheduler.
Option Explicit

Dim shell, fso, root
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' This file lives in <repo>\scripts, so the repo root is one level up.
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

' 0 = hidden window, True = wait for it to exit.
shell.Run """" & root & "\scripts\start-radar.cmd""", 0, True
