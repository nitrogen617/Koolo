package debugoverlay

import (
	"errors"
	"fmt"
	"log/slog"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/hectorgimenez/d2go/pkg/data"
	"github.com/hectorgimenez/d2go/pkg/data/item"
	"github.com/hectorgimenez/koolo/internal/game"
	"github.com/lxn/win"
	"golang.org/x/sys/windows"
)

const overlayClassName = "KooloDebugOverlay"
const overlayColorKey = 0x00000001

type overlayUpdate struct {
	left   int
	top    int
	width  int
	height int
	text   string
	footer string
}

type debugOverlay struct {
	hwnd     win.HWND
	logger   *slog.Logger
	readyCh  chan error
	updateCh chan overlayUpdate
	quitCh   chan struct{}
	doneCh   chan struct{}
	stopOnce sync.Once

	mu     sync.Mutex
	text   string
	footer string
	left   int
	top    int
	width  int
	height int

	stashTabHint int
}

var overlayByHWND sync.Map
var overlayClassOnce sync.Once
var overlayClassErr error

var (
	user32                         = windows.NewLazySystemDLL("user32.dll")
	procSetLayeredWindowAttributes = user32.NewProc("SetLayeredWindowAttributes")
	procFillRect                   = user32.NewProc("FillRect")
	procDrawTextW                  = user32.NewProc("DrawTextW")
)

func newDebugOverlay(logger *slog.Logger) (*debugOverlay, error) {
	o := &debugOverlay{
		logger:   logger,
		readyCh:  make(chan error, 1),
		updateCh: make(chan overlayUpdate, 1),
		quitCh:   make(chan struct{}),
		doneCh:   make(chan struct{}),
	}

	go o.run()

	if err := <-o.readyCh; err != nil {
		return nil, err
	}

	return o, nil
}

func (o *debugOverlay) Stop() {
	if o == nil {
		return
	}
	o.stopOnce.Do(func() {
		close(o.quitCh)
	})
	<-o.doneCh
}

func (o *debugOverlay) Update(left, top, width, height int, text, footer string) {
	if o == nil {
		return
	}
	update := overlayUpdate{
		left:   left,
		top:    top,
		width:  width,
		height: height,
		text:   text,
		footer: footer,
	}
	select {
	case o.updateCh <- update:
	default:
		select {
		case <-o.updateCh:
		default:
		}
		select {
		case o.updateCh <- update:
		default:
		}
	}
}

func (o *debugOverlay) Inspect(gd *game.MemoryReader, gdData *game.Data) (string, string) {
	if gd == nil || gdData == nil {
		return "", ""
	}

	gd.UpdateWindowPositionData()

	text := "UnitID: -"
	if gdData.HoverData.IsHovered {
		text = fmt.Sprintf("UnitID: %d", gdData.HoverData.UnitID)
		if pos, label, ok := o.hoveredPosition(gdData); ok {
			text = fmt.Sprintf("%s %s: %d,%d", text, label, pos.X, pos.Y)
		}
	} else if gdData.OpenMenus.Inventory || gdData.OpenMenus.Stash || gdData.OpenMenus.Cube {
		var pt win.POINT
		if win.GetCursorPos(&pt) {
			cursorX := int(pt.X) - gd.WindowLeftX
			cursorY := int(pt.Y) - gd.WindowTopY
			if cursorX >= 0 && cursorY >= 0 && cursorX <= gd.GameAreaSizeX && cursorY <= gd.GameAreaSizeY {
				if gdData.OpenMenus.Stash {
					o.updateStashTabHint(gdData, cursorX, cursorY)
				}
				if itm, ok := o.findUIItemAtCursor(gdData, cursorX, cursorY); ok {
					name := itm.IdentifiedName
					if name == "" {
						name = string(itm.Name)
					}
					if itm.Location.LocationType == item.LocationEquipped || itm.Location.LocationType == item.LocationMercenary {
						text = fmt.Sprintf("UnitID: %d Slot: %s Name: %s", itm.UnitID, itm.Location.BodyLocation, name)
					} else {
						text = fmt.Sprintf("UnitID: %d Cell: %d,%d Name: %s", itm.UnitID, itm.Position.X, itm.Position.Y, name)
					}
				}
			}
		}
	}

	return text, ""
}

func (o *debugOverlay) UpdateFromGame(gd *game.MemoryReader, gdData *game.Data) {
	text, seedText := o.Inspect(gd, gdData)
	if text == "" && seedText == "" {
		return
	}
	o.Update(gd.WindowLeftX, gd.WindowTopY, gd.GameAreaSizeX, gd.GameAreaSizeY, text, seedText)
}

func (o *debugOverlay) run() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(o.doneCh)

	if err := registerOverlayClass(); err != nil {
		o.readyCh <- err
		return
	}

	hwnd := win.CreateWindowEx(
		win.WS_EX_LAYERED|win.WS_EX_TRANSPARENT|win.WS_EX_TOPMOST|win.WS_EX_TOOLWINDOW,
		syscall.StringToUTF16Ptr(overlayClassName),
		syscall.StringToUTF16Ptr(""),
		win.WS_POPUP,
		0, 0, 1, 1,
		0, 0, 0, nil,
	)
	if hwnd == 0 {
		o.readyCh <- errors.New("failed to create debug overlay window")
		return
	}

	o.hwnd = hwnd
	overlayByHWND.Store(hwnd, o)

	setLayeredWindowAttributes(hwnd, win.RGB(0, 0, 0), 0, overlayColorKey)
	win.ShowWindow(hwnd, win.SW_SHOW)
	o.readyCh <- nil

	var msg win.MSG
	for {
		select {
		case <-o.quitCh:
			win.DestroyWindow(hwnd)
			return
		default:
		}

		for win.PeekMessage(&msg, 0, 0, 0, win.PM_REMOVE) {
			if msg.Message == win.WM_QUIT {
				return
			}
			win.TranslateMessage(&msg)
			win.DispatchMessage(&msg)
		}

		select {
		case update := <-o.updateCh:
			o.applyUpdate(update)
		default:
		}

		time.Sleep(16 * time.Millisecond)
	}
}

func (o *debugOverlay) applyUpdate(update overlayUpdate) {
	if update.width <= 0 || update.height <= 0 {
		return
	}

	o.mu.Lock()
	textChanged := update.text != o.text
	footerChanged := update.footer != o.footer
	sizeChanged := update.left != o.left || update.top != o.top || update.width != o.width || update.height != o.height
	o.text = update.text
	o.footer = update.footer
	o.left = update.left
	o.top = update.top
	o.width = update.width
	o.height = update.height
	o.mu.Unlock()

	if sizeChanged {
		win.SetWindowPos(
			o.hwnd,
			win.HWND_TOPMOST,
			int32(update.left),
			int32(update.top),
			int32(update.width),
			int32(update.height),
			win.SWP_NOACTIVATE,
		)
	}

	if sizeChanged || textChanged || footerChanged {
		win.InvalidateRect(o.hwnd, nil, true)
	}
}

func registerOverlayClass() error {
	overlayClassOnce.Do(func() {
		hInstance := win.GetModuleHandle(nil)
		wc := win.WNDCLASSEX{
			CbSize:        uint32(unsafe.Sizeof(win.WNDCLASSEX{})),
			Style:         win.CS_HREDRAW | win.CS_VREDRAW,
			LpfnWndProc:   syscall.NewCallback(overlayWndProc),
			HInstance:     hInstance,
			HbrBackground: win.HBRUSH(win.GetStockObject(win.BLACK_BRUSH)),
			LpszClassName: syscall.StringToUTF16Ptr(overlayClassName),
		}

		if atom := win.RegisterClassEx(&wc); atom == 0 {
			overlayClassErr = fmt.Errorf("register overlay class failed: %d", win.GetLastError())
		}
	})

	return overlayClassErr
}

func overlayWndProc(hwnd win.HWND, msg uint32, wParam, lParam uintptr) uintptr {
	switch msg {
	case win.WM_ERASEBKGND:
		return 1
	case win.WM_PAINT:
		var ps win.PAINTSTRUCT
		hdc := win.BeginPaint(hwnd, &ps)
		defer win.EndPaint(hwnd, &ps)

		var rect win.RECT
		win.GetClientRect(hwnd, &rect)
		fillRect(hdc, &rect, win.HBRUSH(win.GetStockObject(win.BLACK_BRUSH)))

		if overlayAny, ok := overlayByHWND.Load(hwnd); ok {
			overlay := overlayAny.(*debugOverlay)
			overlay.mu.Lock()
			text := overlay.text
			footer := overlay.footer
			overlay.mu.Unlock()

			if text != "" {
				win.SetBkMode(hdc, win.TRANSPARENT)
				win.SetTextColor(hdc, win.RGB(255, 255, 255))
				rect.Left += 10
				rect.Top += 10
				drawText(hdc, text, &rect, win.DT_LEFT|win.DT_TOP|win.DT_NOPREFIX)
			}
			if footer != "" {
				footerRect := rect
				footerRect.Left += 10
				footerRect.Bottom -= 10
				drawText(hdc, footer, &footerRect, win.DT_LEFT|win.DT_BOTTOM|win.DT_NOPREFIX|win.DT_SINGLELINE)
			}
		}
		return 0
	case win.WM_DESTROY:
		overlayByHWND.Delete(hwnd)
		win.PostQuitMessage(0)
		return 0
	default:
		return win.DefWindowProc(hwnd, msg, wParam, lParam)
	}
}

func setLayeredWindowAttributes(hwnd win.HWND, color win.COLORREF, alpha byte, flags uint32) bool {
	ret, _, _ := procSetLayeredWindowAttributes.Call(
		uintptr(hwnd),
		uintptr(color),
		uintptr(alpha),
		uintptr(flags),
	)
	return ret != 0
}

func fillRect(hdc win.HDC, rect *win.RECT, brush win.HBRUSH) {
	_, _, _ = procFillRect.Call(
		uintptr(hdc),
		uintptr(unsafe.Pointer(rect)),
		uintptr(brush),
	)
}

func drawText(hdc win.HDC, text string, rect *win.RECT, format uint32) int32 {
	ptr := syscall.StringToUTF16Ptr(text)
	ret, _, _ := procDrawTextW.Call(
		uintptr(hdc),
		uintptr(unsafe.Pointer(ptr)),
		uintptr(uint32(0xFFFFFFFF)),
		uintptr(unsafe.Pointer(rect)),
		uintptr(format),
	)
	return int32(ret)
}

const (
	overlayItemBoxSize        = 33
	overlayItemBoxSizeClassic = 35

	overlayInventoryCols = 10
	overlayInventoryRows = 4
	overlayStashCols     = 10
	overlayStashRows     = 10
	overlayCubeCols      = 3
	overlayCubeRows      = 4

	overlayInventoryTopLeftX        = 846
	overlayInventoryTopLeftXClassic = 663
	overlayInventoryTopLeftY        = 369
	overlayInventoryTopLeftYClassic = 379

	overlayVendorWindowTopLeftX        = 109
	overlayVendorWindowTopLeftXClassic = 275
	overlayVendorWindowTopLeftY        = 147
	overlayVendorWindowTopLeftYClassic = 149

	overlayCubeWindowTopLeftX        = 222
	overlayCubeWindowTopLeftXClassic = 398
	overlayCubeWindowTopLeftY        = 247
	overlayCubeWindowTopLeftYClassic = 239

	overlayStashTabStartX        = 107
	overlayStashTabStartXClassic = 258
	overlayStashTabStartY        = 128
	overlayStashTabStartYClassic = 84
	overlayStashTabSize          = 55
	overlayStashTabSizeClassic   = 96

	overlayEquipHeadX = 1005
	overlayEquipHeadY = 160
	overlayEquipNeckX = 1070
	overlayEquipNeckY = 205
	overlayEquipLArmX = 885
	overlayEquipLArmY = 215
	overlayEquipRArmX = 1135
	overlayEquipRArmY = 215
	overlayEquipTorsX = 1005
	overlayEquipTorsY = 260
	overlayEquipBeltX = 1005
	overlayEquipBeltY = 340
	overlayEquipGlovX = 885
	overlayEquipGlovY = 325
	overlayEquipFeetX = 1135
	overlayEquipFeetY = 325
	overlayEquipLRinX = 945
	overlayEquipLRinY = 340
	overlayEquipRRinX = 1070
	overlayEquipRRinY = 340

	overlayEquipHeadClassicX = 833
	overlayEquipHeadClassicY = 110
	overlayEquipNeckClassicX = 905
	overlayEquipNeckClassicY = 130
	overlayEquipLArmClassicX = 700
	overlayEquipLArmClassicY = 190
	overlayEquipRArmClassicX = 975
	overlayEquipRArmClassicY = 190
	overlayEquipTorsClassicX = 833
	overlayEquipTorsClassicY = 210
	overlayEquipBeltClassicX = 833
	overlayEquipBeltClassicY = 300
	overlayEquipGlovClassicX = 700
	overlayEquipGlovClassicY = 315
	overlayEquipFeetClassicX = 975
	overlayEquipFeetClassicY = 315
	overlayEquipLRinClassicX = 770
	overlayEquipLRinClassicY = 300
	overlayEquipRRinClassicX = 905
	overlayEquipRRinClassicY = 300

	overlayEquipMercHeadX = 548
	overlayEquipMercHeadY = 166
	overlayEquipMercLArmX = 463
	overlayEquipMercLArmY = 293
	overlayEquipMercTorsX = 548
	overlayEquipMercTorsY = 293

	overlayEquipMercHeadClassicX = 450
	overlayEquipMercHeadClassicY = 115
	overlayEquipMercLArmClassicX = 380
	overlayEquipMercLArmClassicY = 248
	overlayEquipMercTorsClassicX = 450
	overlayEquipMercTorsClassicY = 248
)

type overlayPanel int

const (
	panelNone overlayPanel = iota
	panelInventory
	panelStash
	panelCube
)

type overlayRect struct {
	left   int
	top    int
	right  int
	bottom int
}

func rectForGrid(left, top, cols, rows, boxSize int) overlayRect {
	return overlayRect{
		left:   left,
		top:    top,
		right:  left + cols*boxSize,
		bottom: top + rows*boxSize,
	}
}

func pointInRect(x, y int, r overlayRect) bool {
	return x >= r.left && x < r.right && y >= r.top && y < r.bottom
}

func (o *debugOverlay) findUIItemAtCursor(gdData *game.Data, cursorX, cursorY int) (data.Item, bool) {
	if gdData.OpenMenus.Inventory || gdData.OpenMenus.Character || gdData.OpenMenus.MercInventory {
		locs := []item.LocationType{item.LocationEquipped}
		if gdData.OpenMenus.MercInventory {
			locs = append(locs, item.LocationMercenary)
		}
		items := gdData.Inventory.ByLocation(locs...)
		for _, itm := range items {
			if left, top, right, bottom, ok := overlayEquippedRect(gdData.LegacyGraphics, itm); ok {
				if cursorX >= left && cursorX < right && cursorY >= top && cursorY < bottom {
					return itm, true
				}
			}
		}
	}

	panel := overlayPanelAtCursor(gdData, cursorX, cursorY)
	if panel == panelNone {
		return data.Item{}, false
	}

	locations := []item.LocationType{}
	switch panel {
	case panelCube:
		locations = append(locations, item.LocationCube)
	case panelStash:
		locations = append(locations, item.LocationStash, item.LocationSharedStash)
	case panelInventory:
		locations = append(locations, item.LocationInventory)
	}

	items := gdData.Inventory.ByLocation(locations...)
	for _, itm := range items {
		if panel == panelStash {
			if !o.itemMatchesStashTabHint(itm) {
				continue
			}
		}
		left, top, right, bottom := overlayItemRect(gdData.LegacyGraphics, itm)
		if cursorX >= left && cursorX < right && cursorY >= top && cursorY < bottom {
			return itm, true
		}
	}

	return data.Item{}, false
}

func (o *debugOverlay) itemMatchesStashTabHint(itm data.Item) bool {
	if o.stashTabHint == 0 {
		return true
	}
	if o.stashTabHint == 1 {
		return itm.Location.LocationType == item.LocationStash
	}
	if itm.Location.LocationType != item.LocationSharedStash {
		return false
	}
	return itm.Location.Page == o.stashTabHint-1
}

func overlayPanelAtCursor(gdData *game.Data, cursorX, cursorY int) overlayPanel {
	boxSize := overlayItemBoxSize
	invLeft := overlayInventoryTopLeftX
	invTop := overlayInventoryTopLeftY
	stashLeft := overlayVendorWindowTopLeftX
	stashTop := overlayVendorWindowTopLeftY
	cubeLeft := overlayCubeWindowTopLeftX
	cubeTop := overlayCubeWindowTopLeftY
	if gdData.LegacyGraphics {
		boxSize = overlayItemBoxSizeClassic
		invLeft = overlayInventoryTopLeftXClassic
		invTop = overlayInventoryTopLeftYClassic
		stashLeft = overlayVendorWindowTopLeftXClassic
		stashTop = overlayVendorWindowTopLeftYClassic
		cubeLeft = overlayCubeWindowTopLeftXClassic
		cubeTop = overlayCubeWindowTopLeftYClassic
	}

	if gdData.OpenMenus.Cube {
		if pointInRect(cursorX, cursorY, rectForGrid(cubeLeft, cubeTop, overlayCubeCols, overlayCubeRows, boxSize)) {
			return panelCube
		}
	}
	if gdData.OpenMenus.Stash {
		if pointInRect(cursorX, cursorY, rectForGrid(stashLeft, stashTop, overlayStashCols, overlayStashRows, boxSize)) {
			return panelStash
		}
	}
	if gdData.OpenMenus.Inventory {
		if pointInRect(cursorX, cursorY, rectForGrid(invLeft, invTop, overlayInventoryCols, overlayInventoryRows, boxSize)) {
			return panelInventory
		}
	}

	return panelNone
}

func (o *debugOverlay) updateStashTabHint(gdData *game.Data, cursorX, cursorY int) {
	if uint16(win.GetKeyState(win.VK_LBUTTON))&0x8000 == 0 {
		return
	}

	startX := overlayStashTabStartX
	startY := overlayStashTabStartY
	tabSize := overlayStashTabSize
	if gdData.LegacyGraphics {
		startX = overlayStashTabStartXClassic
		startY = overlayStashTabStartYClassic
		tabSize = overlayStashTabSizeClassic
	}

	tabRect := overlayRect{
		left:   startX,
		top:    startY,
		right:  startX + tabSize*4,
		bottom: startY + tabSize,
	}
	if !pointInRect(cursorX, cursorY, tabRect) {
		return
	}

	tabIndex := (cursorX-startX)/tabSize + 1
	if tabIndex < 1 || tabIndex > 4 {
		return
	}
	o.stashTabHint = tabIndex
}

func overlayItemRect(legacy bool, itm data.Item) (left, top, right, bottom int) {
	boxSize := overlayItemBoxSize
	invLeft := overlayInventoryTopLeftX
	invTop := overlayInventoryTopLeftY
	vendorLeft := overlayVendorWindowTopLeftX
	vendorTop := overlayVendorWindowTopLeftY
	cubeLeft := overlayCubeWindowTopLeftX
	cubeTop := overlayCubeWindowTopLeftY
	if legacy {
		boxSize = overlayItemBoxSizeClassic
		invLeft = overlayInventoryTopLeftXClassic
		invTop = overlayInventoryTopLeftYClassic
		vendorLeft = overlayVendorWindowTopLeftXClassic
		vendorTop = overlayVendorWindowTopLeftYClassic
		cubeLeft = overlayCubeWindowTopLeftXClassic
		cubeTop = overlayCubeWindowTopLeftYClassic
	}

	baseX := invLeft
	baseY := invTop
	switch itm.Location.LocationType {
	case item.LocationStash, item.LocationSharedStash, item.LocationVendor:
		baseX = vendorLeft
		baseY = vendorTop
	case item.LocationCube:
		baseX = cubeLeft
		baseY = cubeTop
	}

	left = baseX + itm.Position.X*boxSize
	top = baseY + itm.Position.Y*boxSize
	width := itm.Desc().InventoryWidth * boxSize
	height := itm.Desc().InventoryHeight * boxSize
	right = left + width
	bottom = top + height
	return left, top, right, bottom
}

func overlayEquippedRect(legacy bool, itm data.Item) (left, top, right, bottom int, ok bool) {
	merc := itm.Location.LocationType == item.LocationMercenary
	cx, cy, coordOK := overlayEquipCoords(legacy, itm.Location.BodyLocation, merc)
	if !coordOK {
		return 0, 0, 0, 0, false
	}

	boxSize := overlayItemBoxSize
	if legacy {
		boxSize = overlayItemBoxSizeClassic
	}

	width := itm.Desc().InventoryWidth * boxSize
	height := itm.Desc().InventoryHeight * boxSize
	left = cx - width/2
	top = cy - height/2
	right = left + width
	bottom = top + height
	return left, top, right, bottom, true
}

func overlayEquipCoords(legacy bool, bodyLoc item.LocationType, merc bool) (int, int, bool) {
	if merc {
		if legacy {
			switch bodyLoc {
			case item.LocHead:
				return overlayEquipMercHeadClassicX, overlayEquipMercHeadClassicY, true
			case item.LocLeftArm:
				return overlayEquipMercLArmClassicX, overlayEquipMercLArmClassicY, true
			case item.LocTorso:
				return overlayEquipMercTorsClassicX, overlayEquipMercTorsClassicY, true
			}
		} else {
			switch bodyLoc {
			case item.LocHead:
				return overlayEquipMercHeadX, overlayEquipMercHeadY, true
			case item.LocLeftArm:
				return overlayEquipMercLArmX, overlayEquipMercLArmY, true
			case item.LocTorso:
				return overlayEquipMercTorsX, overlayEquipMercTorsY, true
			}
		}
		return 0, 0, false
	}

	if legacy {
		switch bodyLoc {
		case item.LocHead:
			return overlayEquipHeadClassicX, overlayEquipHeadClassicY, true
		case item.LocNeck:
			return overlayEquipNeckClassicX, overlayEquipNeckClassicY, true
		case item.LocLeftArm:
			return overlayEquipLArmClassicX, overlayEquipLArmClassicY, true
		case item.LocRightArm:
			return overlayEquipRArmClassicX, overlayEquipRArmClassicY, true
		case item.LocTorso:
			return overlayEquipTorsClassicX, overlayEquipTorsClassicY, true
		case item.LocBelt:
			return overlayEquipBeltClassicX, overlayEquipBeltClassicY, true
		case item.LocGloves:
			return overlayEquipGlovClassicX, overlayEquipGlovClassicY, true
		case item.LocFeet:
			return overlayEquipFeetClassicX, overlayEquipFeetClassicY, true
		case item.LocLeftRing:
			return overlayEquipLRinClassicX, overlayEquipLRinClassicY, true
		case item.LocRightRing:
			return overlayEquipRRinClassicX, overlayEquipRRinClassicY, true
		}
		return 0, 0, false
	}

	switch bodyLoc {
	case item.LocHead:
		return overlayEquipHeadX, overlayEquipHeadY, true
	case item.LocNeck:
		return overlayEquipNeckX, overlayEquipNeckY, true
	case item.LocLeftArm:
		return overlayEquipLArmX, overlayEquipLArmY, true
	case item.LocRightArm:
		return overlayEquipRArmX, overlayEquipRArmY, true
	case item.LocTorso:
		return overlayEquipTorsX, overlayEquipTorsY, true
	case item.LocBelt:
		return overlayEquipBeltX, overlayEquipBeltY, true
	case item.LocGloves:
		return overlayEquipGlovX, overlayEquipGlovY, true
	case item.LocFeet:
		return overlayEquipFeetX, overlayEquipFeetY, true
	case item.LocLeftRing:
		return overlayEquipLRinX, overlayEquipLRinY, true
	case item.LocRightRing:
		return overlayEquipRRinX, overlayEquipRRinY, true
	}

	return 0, 0, false
}

func (o *debugOverlay) hoveredPosition(gdData *game.Data) (data.Position, string, bool) {
	switch gdData.HoverData.UnitType {
	case 1:
		if monster, ok := gdData.Monsters.FindByID(gdData.HoverData.UnitID); ok {
			return monster.Position, "Pos", true
		}
	case 2:
		if obj, ok := gdData.Objects.FindByID(gdData.HoverData.UnitID); ok {
			return obj.Position, "Pos", true
		}
	case 4:
		if itm, ok := gdData.Inventory.FindByID(gdData.HoverData.UnitID); ok {
			if itm.Location.LocationType == item.LocationGround {
				return itm.Position, "Pos", true
			}
			return itm.Position, "Cell", true
		}
	case 5:
		if ent, ok := gdData.Entrances.FindByID(gdData.HoverData.UnitID); ok {
			return ent.Position, "Pos", true
		}
	}

	return data.Position{}, "", false
}
