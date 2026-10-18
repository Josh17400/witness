package witness

import "syscall"

// quietCrashes stops Windows from showing error dialogs (crash / missing-file boxes) for this
// process: Witness runs games unattended, so failures must go to stderr with a non-zero exit.
func quietCrashes() {
	const semFailCriticalErrors, semNoGPFaultErrorBox, semNoOpenFileErrorBox = 0x0001, 0x0002, 0x8000
	setErrorMode := syscall.NewLazyDLL("kernel32.dll").NewProc("SetErrorMode")
	if setErrorMode.Find() != nil {
		return
	}
	old, _, _ := setErrorMode.Call(0)
	setErrorMode.Call(old | semFailCriticalErrors | semNoGPFaultErrorBox | semNoOpenFileErrorBox)
}
