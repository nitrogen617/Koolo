package action

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/hectorgimenez/d2go/pkg/data"
	"github.com/hectorgimenez/d2go/pkg/data/difficulty"
	"github.com/hectorgimenez/d2go/pkg/data/item"
	"github.com/hectorgimenez/d2go/pkg/data/stat"
	"github.com/hectorgimenez/koolo/internal/action/step"
	"github.com/hectorgimenez/koolo/internal/context"
	"github.com/hectorgimenez/koolo/internal/game"
	"github.com/hectorgimenez/koolo/internal/pickit"
	"github.com/hectorgimenez/koolo/internal/ui"
	"github.com/hectorgimenez/koolo/internal/utils"
)

var errRunewordMakerSkip = errors.New("runeword maker: skip")

func MakeRunewords() error {
	ctx := context.Get()
	ctx.SetLastAction("SocketAddItems")
	cfg := ctx.CharacterCfg

	if !cfg.Game.RunewordMaker.Enabled {
		return nil
	}

	insertItems := ctx.Data.Inventory.ByLocation(item.LocationStash, item.LocationSharedStash, item.LocationInventory)
	baseItems := ctx.Data.Inventory.ByLocation(item.LocationStash, item.LocationSharedStash, item.LocationInventory)

	_, isLevelingChar := ctx.Char.(context.LevelingCharacter)

	enabledRecipes := cfg.Game.RunewordMaker.EnabledRecipes
	enabledSet := make(map[string]struct{}, len(enabledRecipes))
	for _, recipe := range enabledRecipes {
		enabledSet[recipe] = struct{}{}
	}
	if !isLevelingChar {
		for recipe := range ctx.CharacterCfg.Game.RunewordRerollRules {
			enabledSet[recipe] = struct{}{}
		}
	}

	if len(enabledSet) == 0 {
		return nil
	}

	for _, recipe := range Runewords {

		if _, enabled := enabledSet[string(recipe.Name)]; !enabled {
			continue
		}

		ctx.Logger.Debug("Runeword recipe is enabled, processing", "recipe", recipe.Name)

		continueProcessing := true
		for continueProcessing {
			if baseItem, hasBase := hasBaseForRunewordRecipe(baseItems, recipe); hasBase {
				existingTier, hasExisting := currentRunewordBaseTier(ctx, recipe, baseItem.Type().Name)

				// Check if we should skip this base due to tier upgrade logic
				// For leveling characters: always apply tier check (existing behavior)
				// For non-leveling: only apply if AutoUpgrade is enabled
				shouldCheckUpgrade := isLevelingChar || cfg.Game.RunewordMaker.AutoUpgrade
				if shouldCheckUpgrade && hasExisting && (len(recipe.BaseSortOrder) == 0 || baseItem.Desc().Tier() <= existingTier) {
					ctx.Logger.Debug("Skipping recipe - existing runeword has equal or better tier in same base type",
						"recipe", recipe.Name,
						"baseType", baseItem.Type().Name,
						"existingTier", existingTier,
						"newBaseTier", baseItem.Desc().Tier())
					continueProcessing = false
					continue
				}

				// Check if character can wear this item (if OnlyIfWearable is enabled)
				if cfg.Game.RunewordMaker.OnlyIfWearable && !characterMeetsRequirements(ctx, baseItem) {
					ctx.Logger.Debug("Skipping recipe - character cannot wear this base item",
						"recipe", recipe.Name,
						"base", baseItem.Name,
						"requiredStr", baseItem.Desc().RequiredStrength,
						"requiredDex", baseItem.Desc().RequiredDexterity)
					continueProcessing = false
					continue
				}

				if inserts, hasInserts := hasItemsForRunewordRecipe(insertItems, recipe, baseItem); hasInserts {
					err := SocketItems(ctx, recipe, baseItem, inserts...)
					if err != nil {
						if errors.Is(err, errRunewordMakerSkip) {
							ctx.Logger.Debug("Runeword maker: skipping recipe after unsocket failure",
								"runeword", recipe.Name,
								"base", baseItem.Name,
							)
							continueProcessing = false
							continue
						}
						return err
					}

					// Log successful creation of the runeword for easier auditing
					ctx.Logger.Info("Runeword maker: created runeword",
						"runeword", recipe.Name,
						"base", baseItem.Name,
					)

					// Refresh game data so in-memory inventory reflects the newly created runeword
					ctx.RefreshGameData()

					// Recalculate available items from the refreshed game state so the maker
					// doesn't try to reuse the same base or inserts.
					insertItems = ctx.Data.Inventory.ByLocation(item.LocationStash, item.LocationSharedStash, item.LocationInventory)
					baseItems = ctx.Data.Inventory.ByLocation(item.LocationStash, item.LocationSharedStash, item.LocationInventory)
				} else {
					// No inserts available for this recipe at this time
					ctx.Logger.Debug("Runeword maker: no inserts available for recipe; skipping",
						"runeword", recipe.Name,
					)
					continueProcessing = false
				}
			} else {
				// No suitable base found for this recipe
				ctx.Logger.Debug("Runeword maker: no suitable base found for recipe; skipping",
					"runeword", recipe.Name,
				)
				continueProcessing = false
			}
		}
	}
	return nil
}

func SocketItems(ctx *context.Status, recipe Runeword, base data.Item, items ...data.Item) error {

	ctx.SetLastAction("SocketItem")

	if base.IsRuneword {
		ctx.Logger.Warn("Runeword maker: base is already a runeword; aborting",
			"runeword", recipe.Name,
			"base", base.Name,
		)
		_ = step.CloseAllMenus()
		return fmt.Errorf("base already a runeword")
	}

	ins := ctx.Data.Inventory.ByLocation(item.LocationStash, item.LocationSharedStash, item.LocationInventory)
	availableRunes := countAvailableRunes(ins)
	_, isLevelingChar := ctx.Char.(context.LevelingCharacter)
	allowUnsocket := !isLevelingChar
	socketPrefix, socketOK, socketReason := runewordSocketPrefix(base, recipe)
	if !socketOK {
		if isRuneMismatchReason(socketReason) {
			ctx.RefreshGameData()
			if updatedBase, found := ctx.Data.Inventory.FindByID(base.UnitID); found {
				base = updatedBase
				socketPrefix, socketOK, socketReason = runewordSocketPrefix(base, recipe)
			}
		}
		if allowUnsocket && canUnsocketMismatchBase(availableRunes, recipe, socketReason) {
			success, failureReason := unsocketItemWithHelAndScroll(base, "Runeword maker", "base",
				"runeword", recipe.Name,
				"base", base.Name,
				"reason", socketReason,
			)
			if !success {
				ctx.Logger.Warn("Runeword maker: failed to unsocket base; skipping recipe",
					"runeword", recipe.Name,
					"base", base.Name,
					"reason", failureReason,
				)
				_ = step.CloseAllMenus()
				return errRunewordMakerSkip
			}

			ctx.RefreshGameData()
			updatedBase, found := ctx.Data.Inventory.FindByID(base.UnitID)
			if !found {
				ctx.Logger.Warn("Runeword maker: base item missing after unsocket",
					"runeword", recipe.Name,
					"base", base.Name,
				)
				_ = step.CloseAllMenus()
				return fmt.Errorf("base item %s not found after unsocket", base.Name)
			}
			base = updatedBase

			ins = ctx.Data.Inventory.ByLocation(item.LocationStash, item.LocationSharedStash, item.LocationInventory)
			availableRunes = countAvailableRunes(ins)
			socketPrefix, socketOK, socketReason = runewordSocketPrefix(base, recipe)
			if !socketOK {
				ctx.Logger.Warn("Runeword maker: base socketed items still block recipe after unsocket",
					"runeword", recipe.Name,
					"base", base.Name,
					"reason", socketReason,
				)
				_ = step.CloseAllMenus()
				return fmt.Errorf("runeword base incompatible after unsocket: %s", socketReason)
			}
		} else {
			ctx.Logger.Warn("Runeword maker: base socketed items block recipe",
				"runeword", recipe.Name,
				"base", base.Name,
				"reason", socketReason,
			)
			_ = step.CloseAllMenus()
			return fmt.Errorf("runeword base incompatible: %s", socketReason)
		}
	}
	if socketPrefix >= len(recipe.Runes) {
		ctx.Logger.Warn("Runeword maker: base already has full rune set",
			"runeword", recipe.Name,
			"base", base.Name,
		)
		_ = step.CloseAllMenus()
		return fmt.Errorf("runeword base already completed")
	}
	missingRunes := recipe.Runes[socketPrefix:]

	for _, itm := range items {
		if itm.Location.LocationType == item.LocationStash || itm.Location.LocationType == item.LocationSharedStash {
			OpenStash()
			break
		}
	}
	if !ctx.Data.OpenMenus.Stash && (base.Location.LocationType == item.LocationStash || base.Location.LocationType == item.LocationSharedStash) {
		err := OpenStash()
		if err != nil {
			return err
		}
	}

	ctx.RefreshGameData()
	if cursorItems := ctx.Data.Inventory.ByLocation(item.LocationCursor); len(cursorItems) > 0 {
		ctx.Logger.Warn("Runeword maker: cursor item detected before socketing; aborting",
			"runeword", recipe.Name,
			"item", cursorItems[0].Name,
		)
		DropAndRecoverCursorItem()
		_ = step.CloseAllMenus()
		return fmt.Errorf("cursor item present before socketing")
	}

	if base.Location.LocationType == item.LocationSharedStash || base.Location.LocationType == item.LocationStash {
		ctx.Logger.Debug("Base in stash - checking it fits")
		if !itemFitsInventory(base) {
			ctx.Logger.Error("Base item does not fit in inventory", "item", base.Name)
			return step.CloseAllMenus()
		}

		if base.Location.LocationType == item.LocationSharedStash {
			ctx.Logger.Debug("Base in shared stash but fits in inv, switching to correct tab")
			SwitchStashTab(base.Location.Page + 1)
		} else {
			ctx.Logger.Debug("Base in personal stash but fits in inv, switching to correct tab")
			SwitchStashTab(1)
		}
		ctx.Logger.Debug("Switched to correct tab")
		utils.Sleep(500)
		screenPos := ui.GetScreenCoordsForItem(base)
		ctx.Logger.Debug(fmt.Sprintf("Clicking after 5s at %d:%d", screenPos.X, screenPos.Y))
		moveSucceeded := false
		for attempt := 0; attempt < 2; attempt++ {
			ctx.HID.ClickWithModifier(game.LeftButton, screenPos.X, screenPos.Y, game.CtrlKey)
			utils.Sleep(500)
			ctx.RefreshGameData()
			moved, found := ctx.Data.Inventory.FindByID(base.UnitID)
			if found && moved.Location.LocationType == item.LocationInventory {
				base = moved
				moveSucceeded = true
				break
			}
		}
		if !moveSucceeded {
			ctx.Logger.Error("Failed to move base item from stash to inventory", "item", base.Name)
			return step.CloseAllMenus()
		}
	}

	usedItems := make(map[*data.Item]bool)
	orderedItems := make([]data.Item, 0)

	// Process each required insert in order
	for _, requiredInsert := range missingRunes {
		for i := range ins {
			item := &ins[i]
			if string(item.Name) == requiredInsert && !usedItems[item] {
				orderedItems = append(orderedItems, *item)
				usedItems[item] = true
				break
			}
		}
	}
	if len(orderedItems) != len(missingRunes) {
		ctx.Logger.Warn("SocketItems: missing runes for recipe; aborting socketing",
			"runeword", recipe.Name,
			"needed", fmt.Sprintf("%v", missingRunes),
			"found", len(orderedItems),
		)
		_ = step.CloseAllMenus()
		return fmt.Errorf("missing runes for runeword %s", recipe.Name)
	}

	previousPage := -1 // Initialize to invalid page number
	expectedPrefixLen := socketPrefix
	for i, itm := range orderedItems {
		expectedRune := missingRunes[i]
		if itm.Location.LocationType == item.LocationSharedStash || itm.Location.LocationType == item.LocationStash {
			currentPage := itm.Location.Page + 1
			if previousPage != currentPage || currentPage != base.Location.Page {
				SwitchStashTab(currentPage)
			}
			previousPage = currentPage
		}

		picked := false
		for attempt := 0; attempt < 2 && !picked; attempt++ {
			screenPos := ui.GetScreenCoordsForItem(itm)
			ctx.HID.Click(game.LeftButton, screenPos.X, screenPos.Y)
			utils.Sleep(200)

			var cursorItems []data.Item
			for refresh := 0; refresh < 3; refresh++ {
				ctx.RefreshInventory()
				cursorItems = ctx.Data.Inventory.ByLocation(item.LocationCursor)
				if len(cursorItems) > 0 {
					break
				}
				utils.Sleep(150)
			}
			if len(cursorItems) == 0 {
				continue
			}

			if string(cursorItems[0].Name) != expectedRune {
				if placeCursorItemInInventory(cursorItems[0]) {
					ctx.Logger.Warn("Runeword maker: unexpected rune on cursor; placed in inventory and retrying",
						"runeword", recipe.Name,
						"expected", expectedRune,
						"actual", cursorItems[0].Name,
					)
					utils.Sleep(150)
					continue
				}
				ctx.Logger.Warn("Runeword maker: cursor rune mismatch; no inventory space to place",
					"runeword", recipe.Name,
					"expected", expectedRune,
					"actual", cursorItems[0].Name,
				)
				DropAndRecoverCursorItem()
				_ = step.CloseAllMenus()
				return fmt.Errorf("cursor rune mismatch for runeword %s", recipe.Name)
			}

			picked = true
		}
		if !picked {
			ctx.Logger.Warn("Runeword maker: expected rune not on cursor",
				"runeword", recipe.Name,
				"expected", expectedRune,
			)
			_ = step.CloseAllMenus()
			return fmt.Errorf("expected rune %s not on cursor", expectedRune)
		}
		movedBase, found := ctx.Data.Inventory.FindByID(base.UnitID)
		if !found {
			ctx.Logger.Warn("Runeword maker: base item missing while socketing",
				"runeword", recipe.Name,
				"base", base.Name,
			)
			DropAndRecoverCursorItem()
			_ = step.CloseAllMenus()
			return fmt.Errorf("base item %s not found while socketing", base.Name)
		}
		if (movedBase.Location.LocationType == item.LocationStash || movedBase.Location.LocationType == item.LocationSharedStash) &&
			movedBase.Location.Page != itm.Location.Page {
			SwitchStashTab(movedBase.Location.Page + 1)
		}

		basescreenPos := ui.GetScreenCoordsForItem(movedBase)
		ctx.HID.Click(game.LeftButton, basescreenPos.X, basescreenPos.Y)
		utils.Sleep(200)

		inserted := false
		lastCursorCount := 0
		var updatedBase data.Item
		var lastReason string
		for attempt := 0; attempt < 3; attempt++ {
			ctx.RefreshInventory()
			lastCursorCount = len(ctx.Data.Inventory.ByLocation(item.LocationCursor))

			var found bool
			updatedBase, found = ctx.Data.Inventory.FindByID(base.UnitID)
			if !found {
				utils.Sleep(200)
				continue
			}

			newPrefixLen, ok, reason := runewordSocketPrefix(updatedBase, recipe)
			if ok && newPrefixLen == expectedPrefixLen+1 {
				inserted = true
				expectedPrefixLen = newPrefixLen
				break
			}
			lastReason = reason
			utils.Sleep(200)
		}

		if !inserted {
			if lastCursorCount > 0 {
				ctx.Logger.Warn("Runeword maker: failed to insert rune into base",
					"runeword", recipe.Name,
					"rune", expectedRune,
					"base", base.Name,
				)
				DropAndRecoverCursorItem()
				_ = step.CloseAllMenus()
				return fmt.Errorf("failed to insert rune %s into base %s", expectedRune, base.Name)
			}
			if lastReason != "" {
				ctx.Logger.Warn("Runeword maker: base sockets no longer match recipe",
					"runeword", recipe.Name,
					"base", base.Name,
					"reason", lastReason,
				)
				_ = step.CloseAllMenus()
				return fmt.Errorf("base socket mismatch after inserting rune %s", expectedRune)
			}
			ctx.Logger.Warn("Runeword maker: base socket prefix did not advance",
				"runeword", recipe.Name,
				"base", base.Name,
				"expectedPrefix", expectedPrefixLen+1,
				"actualPrefix", expectedPrefixLen,
			)
			_ = step.CloseAllMenus()
			return fmt.Errorf("base socket prefix did not advance for runeword %s", recipe.Name)
		}

		base = updatedBase
		utils.Sleep(300)
	}
	return step.CloseAllMenus()
}

func currentRunewordBaseTier(ctx *context.Status, recipe Runeword, baseType string) (item.Tier, bool) {

	items := ctx.Data.Inventory.ByLocation(
		item.LocationInventory,
		item.LocationEquipped,
		item.LocationStash,
		item.LocationSharedStash,
	)

	for _, itm := range items {
		if itm.RunewordName == recipe.Name && itm.Type().Name == baseType {
			return itm.Desc().Tier(), true
		}
	}
	return 0, false
}

func hasBaseForRunewordRecipe(items []data.Item, recipe Runeword) (data.Item, bool) {
	ctx := context.Get()
	// Determine if this is a leveling character; overrides are ignored for leveling
	// to keep the existing, simpler behavior.
	_, isLevelingChar := ctx.Char.(context.LevelingCharacter)
	isBarbLeveling := ctx.CharacterCfg.Character.Class == "barb_leveling"

	// Look up any per-runeword overrides configured for this character.
	overrides := ctx.CharacterCfg.Game.RunewordOverrides
	ov, hasOverride := overrides[string(recipe.Name)]
	useOverride := !isLevelingChar && hasOverride

	// Runeword maker uses per-runeword overrides only; reroll rules apply during reroll checks.
	effectiveEthMode := ""
	effectiveQualityMode := ""
	effectiveBaseType := ""
	effectiveBaseTier := ""
	effectiveBaseName := ""
	if useOverride && ov.EthMode != "" {
		effectiveEthMode = strings.ToLower(strings.TrimSpace(ov.EthMode))
		if effectiveEthMode == "any" {
			effectiveEthMode = ""
		}
	}
	if useOverride && ov.QualityMode != "" {
		effectiveQualityMode = strings.ToLower(strings.TrimSpace(ov.QualityMode))
		if effectiveQualityMode == "any" {
			effectiveQualityMode = ""
		}
	}
	if useOverride && ov.BaseType != "" {
		effectiveBaseType = strings.TrimSpace(ov.BaseType)
	}
	if useOverride && ov.BaseTier != "" {
		effectiveBaseTier = strings.ToLower(strings.TrimSpace(ov.BaseTier))
	}
	if useOverride && ov.BaseName != "" {
		effectiveBaseName = strings.TrimSpace(ov.BaseName)
	}

	// Auto-select tier based on difficulty if enabled and no manual tier set
	if effectiveBaseTier == "" && ctx.CharacterCfg.Game.RunewordMaker.AutoTierByDifficulty {
		switch ctx.CharacterCfg.Game.Difficulty {
		case difficulty.Normal:
			effectiveBaseTier = "normal"
		case difficulty.Nightmare:
			effectiveBaseTier = "exceptional"
		case difficulty.Hell:
			effectiveBaseTier = "elite"
		}
	}

	availableRunes := countAvailableRunes(items)
	allowUnsocket := !isLevelingChar

	var validBases []data.Item
	socketPrefixes := make(map[data.UnitID]int)
	unsocketCandidates := make(map[data.UnitID]bool)
	for _, itm := range items {
		itemType := itm.Type().Code

		isValidType := false
		for _, baseType := range recipe.BaseItemTypes {
			if itemType == baseType {
				isValidType = true
				break
			}
		}
		if !isValidType {
			continue
		}

		// Apply user-specified base type restriction when not leveling.
		// Supports comma-separated list for multiple base types (e.g., "sword,shield" for Spirit)
		if effectiveBaseType != "" {
			allowedTypes := strings.Split(effectiveBaseType, ",")
			typeAllowed := false
			for _, t := range allowedTypes {
				if strings.TrimSpace(t) == itemType {
					typeAllowed = true
					break
				}
			}
			if !typeAllowed {
				continue
			}
		}

		// exception to use only 1-handed maces/clubs for steel/malice/strength for barb leveling
		if isBarbLeveling && (recipe.Name == item.RunewordSteel || recipe.Name == item.RunewordMalice || recipe.Name == item.RunewordStrength) {
			oneHandMaceTypes := []string{item.TypeMace, item.TypeClub}
			if !slices.Contains(oneHandMaceTypes, itemType) {
				continue
			}
			_, hasTwoHandedMin := itm.BaseStats.FindStat(stat.TwoHandedMinDamage, 0)
			_, hasTwoHandedMax := itm.BaseStats.FindStat(stat.TwoHandedMaxDamage, 0)
			if hasTwoHandedMin || hasTwoHandedMax {
				continue
			}
		}

		sockets, found := itm.FindStat(stat.NumSockets, 0)
		if !found || sockets.Value != len(recipe.Runes) {
			continue
		}

		// Eth handling: reroll rules beat overrides; otherwise fall back to the recipe value.
		switch effectiveEthMode {
		case "eth":
			if !itm.Ethereal {
				continue
			}
		case "noneth":
			if itm.Ethereal {
				continue
			}
		default:
			if itm.Ethereal && !recipe.AllowEth {
				continue
			}
		}

		// Quality handling: reroll rules beat overrides; otherwise allow <= Superior.
		switch effectiveQualityMode {
		case "normal":
			if itm.Quality != item.QualityNormal {
				continue
			}
		case "superior":
			if itm.Quality != item.QualitySuperior {
				continue
			}
		default:
			if itm.Quality > item.QualitySuperior {
				continue
			}
		}

		if itm.IsRuneword {
			continue
		}

		socketPrefix, ok, reason := runewordSocketPrefix(itm, recipe)
		if !ok {
			if allowUnsocket && itm.HasSocketedItems() && canUnsocketMismatchBase(availableRunes, recipe, reason) {
				socketPrefixes[itm.UnitID] = 0
				unsocketCandidates[itm.UnitID] = true
				validBases = append(validBases, itm)
				continue
			}
			if itm.HasSocketedItems() || itm.IsRuneword {
				ctx.Logger.Debug("Skipping base - existing sockets block runeword recipe",
					"runeword", recipe.Name,
					"base", itm.Name,
					"reason", reason,
				)
			}
			continue
		}
		if socketPrefix >= len(recipe.Runes) {
			if itm.HasSocketedItems() {
				ctx.Logger.Debug("Skipping base - already fully socketed for recipe",
					"runeword", recipe.Name,
					"base", itm.Name,
				)
			}
			continue
		}

		// Apply base tier restriction (normal/exceptional/elite) when not leveling.
		if effectiveBaseTier != "" {
			itemTier := itm.Desc().Tier()
			switch effectiveBaseTier {
			case "normal":
				if itemTier != item.TierNormal {
					continue
				}
			case "exceptional":
				if itemTier != item.TierExceptional {
					continue
				}
			case "elite":
				if itemTier != item.TierElite {
					continue
				}
			}
		}

		// BaseName (single NIP code or comma list) only applies outside leveling.
		if effectiveBaseName != "" {
			baseCode := pickit.ToNIPName(itm.Desc().Name)
			if baseCode == "" {
				continue
			}
			allowed := false
			for _, part := range strings.Split(effectiveBaseName, ",") {
				if strings.TrimSpace(part) == baseCode {
					allowed = true
					break
				}
			}
			if !allowed {
				continue
			}
		}

		socketPrefixes[itm.UnitID] = socketPrefix
		validBases = append(validBases, itm)
	}

	if len(validBases) == 0 {
		return data.Item{}, false
	}

	sortBases := func() {
		// Try stat-based sorting first if BaseSortOrder is provided
		if len(recipe.BaseSortOrder) > 0 {
			// Find which stats actually exist on at least one base
			var validSortStats []stat.ID
			for _, statID := range recipe.BaseSortOrder {
				for _, base := range validBases {
					if _, found := base.FindStat(statID, 0); found {
						validSortStats = append(validSortStats, statID)
						break
					}
				}
			}

			// If we have valid stats to sort by, use them
			if len(validSortStats) > 0 {

				slices.SortFunc(validBases, func(a, b data.Item) int {
					prefixA := socketPrefixes[a.UnitID]
					prefixB := socketPrefixes[b.UnitID]
					if prefixA != prefixB {
						return prefixB - prefixA // Prefer bases with more matching runes
					}
					if unsocketCandidates[a.UnitID] != unsocketCandidates[b.UnitID] {
						if unsocketCandidates[a.UnitID] {
							return 1
						}
						return -1
					}
					for _, statID := range validSortStats {
						statA, foundA := a.FindStat(statID, 0)
						statB, foundB := b.FindStat(statID, 0)

						// Skip if neither has this stat
						if !foundA && !foundB {
							continue
						}

						if !foundA {
							return 1 // b comes first
						}
						if !foundB {
							return -1 // a comes first
						}
						if statA.Value != statB.Value {
							return statB.Value - statA.Value // Higher values first
						}
					}
					return 0
				})
				return
			}
		}

		// Fall back to requirement-based sorting
		slices.SortFunc(validBases, func(a, b data.Item) int {
			prefixA := socketPrefixes[a.UnitID]
			prefixB := socketPrefixes[b.UnitID]
			if prefixA != prefixB {
				return prefixB - prefixA // Prefer bases with more matching runes
			}
			if unsocketCandidates[a.UnitID] != unsocketCandidates[b.UnitID] {
				if unsocketCandidates[a.UnitID] {
					return 1
				}
				return -1
			}
			aTotal := a.Desc().RequiredStrength + a.Desc().RequiredDexterity
			bTotal := b.Desc().RequiredStrength + b.Desc().RequiredDexterity
			return aTotal - bTotal // Lower requirements first
		})
	}

	// Sort the bases
	sortBases()

	// Get the best base
	bestBase := validBases[0]

	return bestBase, true
}

func countAvailableRunes(items []data.Item) map[string]int {
	available := make(map[string]int)
	for _, itm := range items {
		name := string(itm.Name)
		if strings.HasSuffix(name, "Rune") {
			available[name]++
		}
	}
	return available
}

func socketedRuneNames(base data.Item) []string {
	socketed := base.GetSocketedItems()
	names := make([]string, 0, len(socketed))
	for _, itm := range socketed {
		names = append(names, string(itm.Name))
	}
	return names
}

func expectedRunePrefix(recipe Runeword, count int) []string {
	if count <= 0 {
		return nil
	}
	if count > len(recipe.Runes) {
		count = len(recipe.Runes)
	}
	return recipe.Runes[:count]
}

func findInventoryPlacementForItem(itm data.Item) (data.Position, bool) {
	ctx := context.Get()
	grid := ctx.Data.Inventory.Matrix()
	lockConfig := ctx.CharacterCfg.Inventory.InventoryLock
	if len(lockConfig) > 0 {
		for y := 0; y < len(grid) && y < len(lockConfig); y++ {
			for x := 0; x < len(grid[0]) && x < len(lockConfig[y]); x++ {
				if lockConfig[y][x] == 0 {
					grid[y][x] = true
				}
			}
		}
	}

	width := itm.Desc().InventoryWidth
	height := itm.Desc().InventoryHeight
	for y := 0; y <= len(grid)-height; y++ {
		for x := 0; x <= len(grid[0])-width; x++ {
			freeSpace := true
			for dy := 0; dy < height; dy++ {
				for dx := 0; dx < width; dx++ {
					if grid[y+dy][x+dx] {
						freeSpace = false
						break
					}
				}
				if !freeSpace {
					break
				}
			}
			if freeSpace {
				return data.Position{X: x, Y: y}, true
			}
		}
	}

	return data.Position{}, false
}

func placeCursorItemInInventory(itm data.Item) bool {
	ctx := context.Get()
	pos, ok := findInventoryPlacementForItem(itm)
	if !ok {
		return false
	}

	targetCoords := ui.GetScreenCoordsForInventoryPosition(pos, item.LocationInventory)
	ctx.HID.Click(game.LeftButton, targetCoords.X, targetCoords.Y)
	utils.Sleep(200)
	ctx.RefreshInventory()
	return len(ctx.Data.Inventory.ByLocation(item.LocationCursor)) == 0
}

func hasRunesForRecipeWithHel(available map[string]int, recipe Runeword) bool {
	if available["HelRune"] < 1 {
		return false
	}

	required := make(map[string]int)
	for _, r := range recipe.Runes {
		required[r]++
	}

	for runeName, cnt := range required {
		needed := cnt
		if runeName == "HelRune" {
			needed = cnt + 1
		}
		if available[runeName] < needed {
			return false
		}
	}

	return true
}

func isRuneMismatchReason(reason string) bool {
	return strings.HasPrefix(reason, "rune mismatch")
}

func canUnsocketMismatchBase(availableRunes map[string]int, recipe Runeword, reason string) bool {
	if !isRuneMismatchReason(reason) {
		return false
	}
	if !hasRunesForRecipeWithHel(availableRunes, recipe) {
		return false
	}
	return true
}

func collectRunesForRecipe(items []data.Item, required []string) ([]data.Item, bool) {
	requiredRunes := make(map[string]int)
	for _, runeName := range required {
		requiredRunes[runeName]++
	}

	itemsForRecipe := make([]data.Item, 0)
	for _, item := range items {
		if count, ok := requiredRunes[string(item.Name)]; ok {
			itemsForRecipe = append(itemsForRecipe, item)

			count -= 1
			if count == 0 {
				delete(requiredRunes, string(item.Name))
				if len(requiredRunes) == 0 {
					return itemsForRecipe, true
				}
			} else {
				requiredRunes[string(item.Name)] = count
			}
		}
	}

	return nil, false
}

func hasItemsForRunewordRecipe(items []data.Item, recipe Runeword, base data.Item) ([]data.Item, bool) {

	if base.IsRuneword {
		return nil, false
	}

	socketPrefix, ok, reason := runewordSocketPrefix(base, recipe)
	if !ok {
		availableRunes := countAvailableRunes(items)
		_, isLevelingChar := context.Get().Char.(context.LevelingCharacter)
		if !isLevelingChar && canUnsocketMismatchBase(availableRunes, recipe, reason) {
			return collectRunesForRecipe(items, recipe.Runes)
		}
		return nil, false
	}
	if socketPrefix >= len(recipe.Runes) {
		return nil, false
	}

	return collectRunesForRecipe(items, recipe.Runes[socketPrefix:])
}

func runewordSocketPrefix(base data.Item, recipe Runeword) (int, bool, string) {
	socketed := base.GetSocketedItems()
	if len(socketed) == 0 {
		return 0, true, ""
	}
	if len(socketed) > len(recipe.Runes) {
		return 0, false, "too many socketed items"
	}

	for i, socketedItem := range socketed {
		if !socketedItem.Type().IsType(item.TypeRune) {
			return 0, false, fmt.Sprintf("non-rune socketed item %s", socketedItem.Name)
		}
		if string(socketedItem.Name) != recipe.Runes[i] {
			return 0, false, fmt.Sprintf("rune mismatch at slot %d", i+1)
		}
	}

	return len(socketed), true, ""
}

// characterMeetsRequirements checks if the character has enough strength and dexterity to wear an item
func characterMeetsRequirements(ctx *context.Status, itm data.Item) bool {
	strStat, hasStr := ctx.Data.PlayerUnit.BaseStats.FindStat(stat.Strength, 0)
	dexStat, hasDex := ctx.Data.PlayerUnit.BaseStats.FindStat(stat.Dexterity, 0)

	charStr := 0
	charDex := 0
	if hasStr {
		charStr = strStat.Value
	}
	if hasDex {
		charDex = dexStat.Value
	}

	reqStr := itm.Desc().RequiredStrength
	reqDex := itm.Desc().RequiredDexterity

	return charStr >= reqStr && charDex >= reqDex
}
