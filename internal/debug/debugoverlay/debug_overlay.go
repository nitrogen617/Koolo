package debugoverlay

import (
	stdctx "context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"math"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hectorgimenez/d2go/pkg/data"
	"github.com/hectorgimenez/d2go/pkg/data/item"
	botctx "github.com/hectorgimenez/koolo/internal/context"
	"github.com/hectorgimenez/koolo/internal/game"
	"github.com/hectorgimenez/koolo/internal/pather"
	"github.com/inkeliz/gowebview"
	"github.com/lxn/win"
)

//go:embed assets/*
var overlayAssets embed.FS

const (
	overlayScale        = 2.5
	overlayRange        = 120.0
	overlayWindowWidth  = int64(760)
	overlayWindowHeight = int64(720)
)

// DebugOverlay opens a lightweight window that polls the bot context and renders
// nearby rooms/objects for debugging purposes. Mainly useful for pathfinding and
// navigation issues.
type DebugOverlay struct {
	ctx    *botctx.Status
	logger *slog.Logger

	running atomic.Bool

	mu     sync.Mutex
	server *overlayServer
	window *overlayWindow

	hoverInspector *debugOverlay
	mapFetchMu     sync.Mutex
	lastMapFetch   time.Time
}

type overlayServer struct {
	overlay  *DebugOverlay
	listener net.Listener
	server   *http.Server
}

type overlayWindow struct {
	view gowebview.WebView
}

func newOverlayServer(po *DebugOverlay) (*overlayServer, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen overlay: %w", err)
	}

	assetsFS, err := fs.Sub(overlayAssets, "assets")
	if err != nil {
		return nil, fmt.Errorf("load overlay assets: %w", err)
	}
	fileServer := http.FileServer(http.FS(assetsFS))

	mux := http.NewServeMux()
	srv := &overlayServer{
		overlay:  po,
		listener: listener,
		server: &http.Server{
			Handler:      mux,
			ReadTimeout:  5 * time.Second,
			WriteTimeout: 5 * time.Second,
		},
	}

	mux.Handle("/", fileServer)
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/data", srv.handleData)

	return srv, nil
}

func (s *overlayServer) start() error {
	if s == nil {
		return errors.New("nil overlay server")
	}

	go func() {
		if err := s.server.Serve(s.listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.overlay.logger.Error("Overlay server stopped", slog.Any("error", err))
		}
	}()

	return nil
}

func (s *overlayServer) stop() {
	if s == nil {
		return
	}

	ctx, cancel := stdctx.WithTimeout(stdctx.Background(), time.Second)
	defer cancel()
	_ = s.server.Shutdown(ctx)
	_ = s.listener.Close()
}

func (s *overlayServer) url() string {
	if s == nil || s.listener == nil {
		return ""
	}
	return fmt.Sprintf("http://%s/", s.listener.Addr().String())
}

func (s *overlayServer) handleData(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")

	payload := s.overlay.collectData()
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		s.overlay.logger.Debug("Failed to encode overlay payload", slog.Any("error", err))
	}
}

func newOverlayWindow(characterName, url string) (*overlayWindow, error) {
	windowSize := &gowebview.Point{X: overlayWindowWidth, Y: overlayWindowHeight}
	w, err := gowebview.New(&gowebview.Config{
		URL: url,
		WindowConfig: &gowebview.WindowConfig{
			Title: fmt.Sprintf("Debug Overlay - %s", characterName),
			Size:  windowSize,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("create overlay window: %w", err)
	}

	w.SetSize(windowSize, gowebview.HintFixed)

	return &overlayWindow{view: w}, nil
}

func (w *overlayWindow) run(onClosed func()) {
	if w == nil || w.view == nil {
		return
	}

	go func() {
		defer func() {
			w.view.Destroy()
		}()

		w.view.Run()
		if onClosed != nil {
			onClosed()
		}
	}()
}

func (w *overlayWindow) close() {
	if w == nil || w.view == nil {
		return
	}
	w.view.Terminate()
}

var overlayInstances sync.Map

func Instance(status *botctx.Status) *DebugOverlay {
	if status == nil || status.Context == nil {
		return nil
	}

	key := status.Context
	if existing, ok := overlayInstances.Load(key); ok {
		po := existing.(*DebugOverlay)
		po.UpdateStatus(status)
		return po
	}

	po := NewDebugOverlay(status)
	overlayInstances.Store(key, po)
	return po
}

type overlayPoint struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Size float64 `json:"size"`
	Kind string  `json:"kind"`
}

type overlayPayload struct {
	Scale      float64        `json:"scale"`
	Tiles      []overlayTile  `json:"tiles"`
	Path       []overlayPoint `json:"path"`
	Objects    []overlayPoint `json:"objects"`
	Doors      []overlayPoint `json:"doors"`
	Portals    []overlayPoint `json:"portals"`
	Entrances  []overlayPoint `json:"entrances"`
	Monsters   []overlayPoint `json:"monsters"`
	Meta       string         `json:"meta"`
	Hover      string         `json:"hover"`
	Footer     string         `json:"footer"`
	Player     string         `json:"player"`
	Target     string         `json:"target"`
	PathLen    int            `json:"pathLen"`
	LastAction string         `json:"lastAction"`
	LastStep   string         `json:"lastStep"`
}

type overlayTile struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Type int     `json:"type"`
}

func NewDebugOverlay(ctx *botctx.Status) *DebugOverlay {
	return &DebugOverlay{
		ctx:            ctx,
		hoverInspector: &debugOverlay{},
		logger: ctx.Logger.With(
			slog.String("component", "DebugOverlay"),
			slog.String("supervisor", ctx.Name),
		),
	}
}

func (po *DebugOverlay) UpdateStatus(ctx *botctx.Status) {
	if ctx == nil {
		return
	}

	po.ctx = ctx
	if po.hoverInspector == nil {
		po.hoverInspector = &debugOverlay{}
	}
	po.logger = ctx.Logger.With(
		slog.String("component", "DebugOverlay"),
		slog.String("supervisor", ctx.Name),
	)
}

func (po *DebugOverlay) Toggle() error {
	if po.running.Load() {
		po.Stop()
		return nil
	}
	return po.Start()
}

func (po *DebugOverlay) IsRunning() bool {
	if po == nil {
		return false
	}
	return po.running.Load()
}

func (po *DebugOverlay) Start() error {
	if !po.running.CompareAndSwap(false, true) {
		return nil
	}

	server, err := newOverlayServer(po)
	if err != nil {
		po.running.Store(false)
		return err
	}

	po.mu.Lock()
	po.server = server
	po.mu.Unlock()

	if err := server.start(); err != nil {
		po.running.Store(false)
		return err
	}

	window, err := newOverlayWindow(po.ctx.Name, server.url())
	if err != nil {
		po.stopServer()
		po.running.Store(false)
		return err
	}

	po.setWindow(window)
	window.run(po.windowClosed)

	po.logger.Info("Overlay window opened", slog.String("url", server.url()))
	return nil
}

func (po *DebugOverlay) Stop() {
	if !po.running.CompareAndSwap(true, false) {
		return
	}

	po.logger.Info("Stopping Overlay")
	po.stopServer()
	po.stopWindow()
}

func (po *DebugOverlay) setWindow(w *overlayWindow) {
	po.mu.Lock()
	defer po.mu.Unlock()
	po.window = w
}

func (po *DebugOverlay) stopWindow() {
	po.mu.Lock()
	w := po.window
	po.window = nil
	po.mu.Unlock()

	if w != nil {
		w.close()
	}
}

func (po *DebugOverlay) windowClosed() {
	if po.running.CompareAndSwap(true, false) {
		po.stopServer()
	}
}

func (po *DebugOverlay) stopServer() {
	po.mu.Lock()
	server := po.server
	po.server = nil
	po.mu.Unlock()

	if server != nil {
		server.stop()
	}
}

func (po *DebugOverlay) collectData() overlayPayload {
	dataSnapshot := po.ctx.Data
	payload := overlayPayload{
		Scale: overlayScale,
		Meta:  "Waiting for game state...",
	}

	if dataSnapshot == nil || !dataSnapshot.IsIngame {
		return payload
	}

	po.ensureMapData(dataSnapshot)

	player := dataSnapshot.PlayerUnit.Position

	objects := make([]overlayPoint, 0, len(dataSnapshot.Objects))
	doors := make([]overlayPoint, 0, 32)
	portals := make([]overlayPoint, 0, 16)
	for _, obj := range dataSnapshot.Objects {
		dx := obj.Position.X - player.X
		dy := obj.Position.Y - player.Y
		if !withinRange(dx, dy) {
			continue
		}

		if obj.IsDoor() {
			if len(doors) < 80 {
				doors = append(doors, overlayPoint{
					X:    relX(obj.Position, player),
					Y:    relY(obj.Position, player),
					Size: 4,
					Kind: "Door",
				})
			}
			continue
		}
		if obj.IsPortal() || obj.IsRedPortal() {
			if len(portals) < 40 {
				kind := "Portal"
				if obj.IsRedPortal() {
					kind = "RedPortal"
				}
				portals = append(portals, overlayPoint{
					X:    relX(obj.Position, player),
					Y:    relY(obj.Position, player),
					Size: 4.5,
					Kind: kind,
				})
			}
			continue
		}

		objects = append(objects, overlayPoint{
			X:    relX(obj.Position, player),
			Y:    relY(obj.Position, player),
			Size: 2,
			Kind: fmt.Sprintf("%v", obj.Name),
		})

		if len(objects) >= 80 {
			break
		}
	}

	entrances := make([]overlayPoint, 0, len(dataSnapshot.Entrances))
	for _, ent := range dataSnapshot.Entrances {
		dx := ent.Position.X - player.X
		dy := ent.Position.Y - player.Y
		if !withinRange(dx, dy) {
			continue
		}
		entrances = append(entrances, overlayPoint{
			X:    relX(ent.Position, player),
			Y:    relY(ent.Position, player),
			Size: 4,
			Kind: "Entrance",
		})
		if len(entrances) >= 80 {
			break
		}
	}
	for _, lvl := range dataSnapshot.AdjacentLevels {
		if !lvl.IsEntrance {
			continue
		}
		if lvl.Position.X == 0 && lvl.Position.Y == 0 {
			continue
		}
		dx := lvl.Position.X - player.X
		dy := lvl.Position.Y - player.Y
		if !withinRange(dx, dy) {
			continue
		}
		entrances = append(entrances, overlayPoint{
			X:    relX(lvl.Position, player),
			Y:    relY(lvl.Position, player),
			Size: 4,
			Kind: "Entrance",
		})
		if len(entrances) >= 80 {
			break
		}
	}

	monsters := make([]overlayPoint, 0, len(dataSnapshot.Monsters))
	for _, monster := range dataSnapshot.Monsters.Enemies() {
		dx := monster.Position.X - player.X
		dy := monster.Position.Y - player.Y
		if !withinRange(dx, dy) {
			continue
		}

		size := 2.5
		if monster.Type == data.MonsterTypeChampion || monster.Type == data.MonsterTypeUnique || monster.Type == data.MonsterTypeSuperUnique {
			size = 3.5
		}

		monsters = append(monsters, overlayPoint{
			X:    relX(monster.Position, player),
			Y:    relY(monster.Position, player),
			Size: size,
			Kind: string(monster.Type),
		})

		if len(monsters) >= 80 {
			break
		}
	}

	tiles := po.collectTiles(dataSnapshot, player)
	payload.Tiles = tiles
	payload.Path = po.collectPath(player)
	payload.Objects = objects
	payload.Doors = doors
	payload.Portals = portals
	payload.Entrances = entrances
	payload.Monsters = monsters
	meta := fmt.Sprintf("%s | tiles:%d objects:%d monsters:%d", dataSnapshot.PlayerUnit.Area.Area().Name, len(tiles), len(objects), len(monsters))
	if po.ctx != nil && po.ctx.GameReader != nil {
		if seed := po.ctx.GameReader.MapSeed(); seed > 0 {
			meta = fmt.Sprintf("%s | seed:%d", meta, seed)
		}
	}
	payload.Meta = meta
	if po.hoverInspector != nil && po.ctx != nil {
		hoverText, hoverFooter := po.hoverInspector.Inspect(po.ctx, po.ctx.GameReader, dataSnapshot)
		payload.Hover = hoverText
		payload.Footer = hoverFooter
	}
	payload.Player = fmt.Sprintf("Pos: %d,%d", player.X, player.Y)

	targetInfo := ""
	if dataSnapshot.HoverData.IsHovered && dataSnapshot.HoverData.UnitID != 0 {
		targetType := "Unknown"
		switch dataSnapshot.HoverData.UnitType {
		case 1:
			targetType = "Monster"
		case 2:
			targetType = "Object"
		case 4:
			targetType = "Item"
		case 5:
			targetType = "Entrance"
		}
		hasPos := false
		targetPos := data.Position{}
		if po.hoverInspector != nil {
			if pos, _, ok := po.hoverInspector.hoveredPosition(dataSnapshot); ok {
				hasPos = true
				targetPos = pos
			}
		}
		if hasPos {
			dist := pather.DistanceFromPoint(player, targetPos)
			los := false
			if po.ctx != nil && po.ctx.PathFinder != nil {
				los = po.ctx.PathFinder.LineOfSight(player, targetPos)
			}
			losText := "No"
			if los {
				losText = "Yes"
			}
			targetInfo = fmt.Sprintf("Target: %d (%s) Dist:%d LoS:%s", dataSnapshot.HoverData.UnitID, targetType, dist, losText)
		} else {
			targetInfo = fmt.Sprintf("Target: %d (%s)", dataSnapshot.HoverData.UnitID, targetType)
		}
	}

	if po.ctx != nil && po.ctx.PathFinder != nil {
		if lastPath, ok := po.ctx.PathFinder.LastPathDebug(); ok && len(lastPath.Path) > 0 {
			if targetInfo == "" {
				targetInfo = fmt.Sprintf("Target: %d,%d", lastPath.To.X, lastPath.To.Y)
			}
			payload.PathLen = len(lastPath.Path)
		}
	}
	payload.Target = targetInfo
	if po.ctx != nil && po.ctx.Context != nil {
		if dbg, ok := po.ctx.Context.ContextDebug[po.ctx.ExecutionPriority]; ok && dbg != nil {
			payload.LastAction = dbg.LastAction
			payload.LastStep = dbg.LastStep
		}
	}

	return payload
}

func (po *DebugOverlay) ensureMapData(dataSnapshot *game.Data) {
	if po == nil || dataSnapshot == nil || !dataSnapshot.IsIngame {
		return
	}
	if dataSnapshot.AreaData.Grid != nil {
		return
	}
	if po.ctx == nil || po.ctx.GameReader == nil {
		return
	}

	po.mapFetchMu.Lock()
	if time.Since(po.lastMapFetch) < 5*time.Second {
		po.mapFetchMu.Unlock()
		return
	}
	po.lastMapFetch = time.Now()
	po.mapFetchMu.Unlock()

	if err := po.ctx.GameReader.FetchMapData(); err != nil {
		po.logger.Debug("Failed to refresh map data", slog.Any("error", err))
	}
}

func (po *DebugOverlay) collectTiles(dataSnapshot *game.Data, player data.Position) []overlayTile {
	grid := dataSnapshot.AreaData.Grid
	if grid == nil {
		return nil
	}

	startX := grid.OffsetX
	endX := grid.OffsetX + grid.Width - 1
	startY := grid.OffsetY
	endY := grid.OffsetY + grid.Height - 1
	rangeSize := int(overlayRange)
	startX = max(player.X-rangeSize, grid.OffsetX)
	endX = min(player.X+rangeSize, grid.OffsetX+grid.Width-1)
	startY = max(player.Y-rangeSize, grid.OffsetY)
	endY = min(player.Y+rangeSize, grid.OffsetY+grid.Height-1)
	tiles := make([]overlayTile, 0, (endX-startX+1)*(endY-startY+1))

	for worldY := startY; worldY <= endY; worldY++ {
		gridY := worldY - grid.OffsetY
		for worldX := startX; worldX <= endX; worldX++ {
			gridX := worldX - grid.OffsetX
			cell := grid.Get(gridX, gridY)
			switch cell {
			case game.CollisionTypeWalkable,
				game.CollisionTypeLowPriority,
				game.CollisionTypeNonWalkable,
				game.CollisionTypeTeleportOver,
				game.CollisionTypeObject,
				game.CollisionTypeThickened:
			default:
				continue
			}
			tiles = append(tiles, overlayTile{
				X:    relX(data.Position{X: worldX, Y: worldY}, player),
				Y:    relY(data.Position{X: worldX, Y: worldY}, player),
				Type: int(cell),
			})
		}
	}

	return tiles
}

func (po *DebugOverlay) collectPath(player data.Position) []overlayPoint {
	if po.ctx.PathFinder == nil {
		return nil
	}

	lastPath, ok := po.ctx.PathFinder.LastPathDebug()
	if !ok || len(lastPath.Path) == 0 {
		return nil
	}

	points := make([]overlayPoint, 0, len(lastPath.Path))
	for _, node := range lastPath.Path {
		dx := node.X - player.X
		dy := node.Y - player.Y
		if !withinRange(dx, dy) {
			continue
		}
		points = append(points, overlayPoint{
			X: relX(node, player),
			Y: relY(node, player),
		})
	}

	return points
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func withinRange(dx, dy int) bool {
	return math.Abs(float64(dx)) <= overlayRange && math.Abs(float64(dy)) <= overlayRange
}

func relX(pos data.Position, player data.Position) float64 {
	return float64(pos.X - player.X)
}

func relY(pos data.Position, player data.Position) float64 {
	return float64(pos.Y - player.Y)
}

type debugOverlay struct {
	stashTabHint        int
	lastContextStashTab int
}

func (o *debugOverlay) Inspect(ctx *botctx.Status, gd *game.MemoryReader, gdData *game.Data) (string, string) {
	if gd == nil || gdData == nil {
		return "", ""
	}

	o.syncStashTabHint(ctx, gdData)
	gd.UpdateWindowPositionData()

	text := "UnitID: -"
	if gdData.HoverData.IsHovered {
		if gdData.HoverData.UnitType == 4 {
			if itm, ok := gdData.Inventory.FindByID(gdData.HoverData.UnitID); ok {
				o.updateStashTabHintFromItem(itm)
				name := itm.IdentifiedName
				if name == "" {
					name = string(itm.Name)
				}
				if itm.Location.LocationType == item.LocationEquipped || itm.Location.LocationType == item.LocationMercenary {
					text = fmt.Sprintf("UnitID: %d Slot: %s Name: %s", itm.UnitID, itm.Location.BodyLocation, name)
				} else {
					text = fmt.Sprintf("UnitID: %d Cell: %d,%d Name: %s", itm.UnitID, itm.Position.X, itm.Position.Y, name)
				}
			} else {
				text = fmt.Sprintf("UnitID: %d", gdData.HoverData.UnitID)
			}
		} else {
			text = fmt.Sprintf("UnitID: %d", gdData.HoverData.UnitID)
			if pos, label, ok := o.hoveredPosition(gdData); ok {
				text = fmt.Sprintf("%s %s: %d,%d", text, label, pos.X, pos.Y)
			}
		}
	} else if gdData.OpenMenus.Inventory || gdData.OpenMenus.Stash || gdData.OpenMenus.Cube {
		if itm, ok := o.findHoveredItem(gdData); ok {
			o.updateStashTabHintFromItem(itm)
			text = formatItemHoverText(itm)
		} else {
			var pt win.POINT
			if win.GetCursorPos(&pt) {
				cursorX := int(pt.X) - gd.WindowLeftX
				cursorY := int(pt.Y) - gd.WindowTopY
				if cursorX >= 0 && cursorY >= 0 && cursorX <= gd.GameAreaSizeX && cursorY <= gd.GameAreaSizeY {
					if gdData.OpenMenus.Stash {
						o.updateStashTabHint(gdData, cursorX, cursorY)
					}
					if itm, ok := o.findUIItemAtCursor(gdData, cursorX, cursorY); ok {
						o.updateStashTabHintFromItem(itm)
						text = formatItemHoverText(itm)
					}
				}
			}
		}
	}

	return text, ""
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

func (o *debugOverlay) syncStashTabHint(ctx *botctx.Status, gdData *game.Data) {
	if o == nil || gdData == nil {
		return
	}
	if !gdData.OpenMenus.Stash {
		o.stashTabHint = 0
		return
	}
	if ctx == nil {
		return
	}

	tab := int(ctx.LastStashTab.Load())
	if tab < 1 || tab > 4 {
		return
	}
	if tab != o.lastContextStashTab {
		o.lastContextStashTab = tab
		o.stashTabHint = tab
	}
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
	if panel != panelStash {
		for _, itm := range items {
			left, top, right, bottom := overlayItemRect(gdData.LegacyGraphics, itm)
			if cursorX >= left && cursorX < right && cursorY >= top && cursorY < bottom {
				return itm, true
			}
		}
		return data.Item{}, false
	}

	candidates := make([]data.Item, 0, 4)
	for _, itm := range items {
		left, top, right, bottom := overlayItemRect(gdData.LegacyGraphics, itm)
		if cursorX >= left && cursorX < right && cursorY >= top && cursorY < bottom {
			candidates = append(candidates, itm)
		}
	}
	if len(candidates) == 0 {
		return data.Item{}, false
	}
	if len(candidates) == 1 {
		return candidates[0], true
	}

	filtered := o.filterStashCandidates(candidates)
	if len(filtered) == 1 {
		return filtered[0], true
	}
	if len(filtered) > 1 {
		return data.Item{}, false
	}
	if o.stashTabHint != 0 {
		return data.Item{}, false
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

func (o *debugOverlay) filterStashCandidates(candidates []data.Item) []data.Item {
	if o.stashTabHint == 0 {
		return nil
	}
	filtered := make([]data.Item, 0, len(candidates))
	for _, itm := range candidates {
		if o.itemMatchesStashTabHint(itm) {
			filtered = append(filtered, itm)
		}
	}
	return filtered
}

func (o *debugOverlay) findHoveredItem(gdData *game.Data) (data.Item, bool) {
	for _, itm := range gdData.Inventory.AllItems {
		if !itm.IsHovered {
			continue
		}
		switch itm.Location.LocationType {
		case item.LocationInventory,
			item.LocationStash,
			item.LocationSharedStash,
			item.LocationCube,
			item.LocationEquipped,
			item.LocationMercenary:
			return itm, true
		}
	}
	return data.Item{}, false
}

func formatItemHoverText(itm data.Item) string {
	name := itm.IdentifiedName
	if name == "" {
		name = string(itm.Name)
	}
	if itm.Location.LocationType == item.LocationEquipped || itm.Location.LocationType == item.LocationMercenary {
		return fmt.Sprintf("UnitID: %d Slot: %s Name: %s", itm.UnitID, itm.Location.BodyLocation, name)
	}
	return fmt.Sprintf("UnitID: %d Cell: %d,%d Name: %s", itm.UnitID, itm.Position.X, itm.Position.Y, name)
}

func (o *debugOverlay) updateStashTabHintFromItem(itm data.Item) {
	if o == nil {
		return
	}
	switch itm.Location.LocationType {
	case item.LocationStash:
		o.stashTabHint = 1
	case item.LocationSharedStash:
		if itm.Location.Page >= 1 && itm.Location.Page <= 3 {
			o.stashTabHint = itm.Location.Page + 1
		}
	}
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
