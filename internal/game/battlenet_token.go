package game

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"github.com/go-rod/rod/lib/proto"
)

// GetBattleNetToken automatically logs in to Battle.net and retrieves the authentication token
// This function is only called when the user clicks "Generate Token" button (once per year)
// Memory usage: ~100MB for 5-10 seconds, then completely released
func GetBattleNetToken(username, password, realm string) (string, error) {
	// Launch headless browser (runs in background, user won't see it)
	l := launcher.New().Headless(true).MustLaunch()
	browser := rod.New().ControlURL(l).MustConnect()
	defer browser.MustClose() // Browser will be closed when this function returns

	// Set timeout (2 minutes should be enough)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	page := browser.Context(ctx).MustPage()

	// Determine login URL based on realm
	loginURL := getBattleNetLoginURL(realm)

	// Navigate to Battle.net login page
	err := page.Navigate(loginURL)
	if err != nil {
		return "", fmt.Errorf("failed to navigate to login page: %w", err)
	}

	// Wait for page to load
	page.MustWaitLoad()

	// Step 1: Enter email/phone
	emailInput, err := page.Timeout(10 * time.Second).Element("input[type='text']")
	if err != nil {
		return "", fmt.Errorf("failed to find email input field: %w", err)
	}
	err = emailInput.Input(username)
	if err != nil {
		return "", fmt.Errorf("failed to input username: %w", err)
	}

	// Click Continue button
	continueBtn, err := page.Timeout(5 * time.Second).Element("button[type='submit']")
	if err != nil {
		return "", fmt.Errorf("failed to find continue button: %w", err)
	}
	err = continueBtn.Click(proto.InputMouseButtonLeft, 1)
	if err != nil {
		return "", fmt.Errorf("failed to click continue button: %w", err)
	}

	// Step 2: Wait for password page and enter password
	time.Sleep(2 * time.Second) // Give page time to load

	passwordInput, err := page.Timeout(10 * time.Second).Element("input[type='password']")
	if err != nil {
		return "", fmt.Errorf("failed to find password input field (possible 2FA or CAPTCHA): %w", err)
	}
	err = passwordInput.Input(password)
	if err != nil {
		return "", fmt.Errorf("failed to input password: %w", err)
	}

	// Click Login button
	loginBtn, err := page.Timeout(5 * time.Second).Element("button[type='submit']")
	if err != nil {
		return "", fmt.Errorf("failed to find login button: %w", err)
	}
	err = loginBtn.Click(proto.InputMouseButtonLeft, 1)
	if err != nil {
		return "", fmt.Errorf("failed to click login button: %w", err)
	}

	// Step 3: Wait for login to complete (wait for redirect or specific element)
	time.Sleep(5 * time.Second) // Give time for login to process

	// Step 4: Extract token from cookies
	cookies, err := page.Cookies([]string{})
	if err != nil {
		return "", fmt.Errorf("failed to get cookies: %w", err)
	}

	// Try multiple possible cookie names
	tokenNames := []string{"BA-tkt", "authToken", "web_token", "WEB_TOKEN", "auth_token"}

	for _, cookie := range cookies {
		for _, name := range tokenNames {
			if cookie.Name == name && cookie.Value != "" {
				// Found the token!
				return cookie.Value, nil
			}
		}
	}

	// If token not found in common names, look for any cookie that might be the token
	// Battle.net tokens are typically long strings
	for _, cookie := range cookies {
		if len(cookie.Value) > 50 && cookie.Domain != "" {
			// This might be the token
			return cookie.Value, nil
		}
	}

	return "", errors.New("authentication token not found in cookies. Possible reasons: incorrect credentials, 2FA enabled, CAPTCHA required, or token cookie name changed")
}

// getBattleNetLoginURL returns the appropriate Battle.net login URL based on realm
func getBattleNetLoginURL(realm string) string {
	switch realm {
	case "eu.actual.battle.net":
		return "https://eu.battle.net/login/en/?externalChallenge=login&app=OSI"
	case "kr.actual.battle.net":
		return "https://kr.battle.net/login/en/?externalChallenge=login&app=OSI"
	case "us.actual.battle.net":
		return "https://us.battle.net/login/en/?externalChallenge=login&app=OSI"
	default:
		// Default to US
		return "https://us.battle.net/login/en/?externalChallenge=login&app=OSI"
	}
}
