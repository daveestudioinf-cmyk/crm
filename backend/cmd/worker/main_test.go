package main

import (
	"testing"
	"time"
)

func TestBackoffDelay(t *testing.T) {
	tests := []struct {
		attempts int
		want     time.Duration
	}{
		{-1, 5 * time.Second},
		{0, 5 * time.Second},
		{1, 10 * time.Second},
		{2, 20 * time.Second},
		{3, 40 * time.Second},
		{4, 80 * time.Second},
		{5, 160 * time.Second},
		{10, 1 * time.Hour},
		{20, 1 * time.Hour},
	}

	for _, tc := range tests {
		got := backoffDelay(tc.attempts)
		if got != tc.want {
			t.Errorf("backoffDelay(%d) = %v, want %v", tc.attempts, got, tc.want)
		}
	}
}

func TestStuckRecoveryStatus(t *testing.T) {
	if got := stuckRecoveryStatus(1, 5); got != "pending" {
		t.Fatalf("expected pending when attempts < maxAttempts, got %q", got)
	}
	if got := stuckRecoveryStatus(4, 5); got != "pending" {
		t.Fatalf("expected pending when attempts < maxAttempts, got %q", got)
	}
	if got := stuckRecoveryStatus(5, 5); got != "failed" {
		t.Fatalf("expected failed when attempts == maxAttempts, got %q", got)
	}
	if got := stuckRecoveryStatus(7, 5); got != "failed" {
		t.Fatalf("expected failed when attempts > maxAttempts, got %q", got)
	}
}

func TestScoreSentimentAndThreshold(t *testing.T) {
	negMsg := "Esto es una estafa horrible, voy con mi abogado a poner demanda"
	negScore := scoreSentiment(negMsg)
	if negScore > negativeSentimentThreshold {
		t.Fatalf("expected negative score <= %.2f for %q, got %.2f", negativeSentimentThreshold, negMsg, negScore)
	}
	if negScore < -1.0 {
		t.Fatalf("expected score clamped >= -1.0, got %.2f", negScore)
	}

	neutralScore := scoreSentiment("Hola, quiero consultar horarios")
	if neutralScore != 0.0 {
		t.Fatalf("expected neutral score 0.0, got %.2f", neutralScore)
	}

	posScore := scoreSentiment("Muchas gracias, excelente servicio, muy rápido y amable!")
	if posScore <= 0.0 {
		t.Fatalf("expected positive score > 0.0, got %.2f", posScore)
	}
	if posScore > 1.0 {
		t.Fatalf("expected score clamped <= 1.0, got %.2f", posScore)
	}
}

func TestMapEvolutionStateToStatus(t *testing.T) {
	cases := map[string]string{
		"open":       "WORKING",
		"OPEN":       "WORKING",
		"connecting": "SCAN_QR_CODE",
		"close":      "FAILED",
		"closed":     "FAILED",
		"unknown":    "",
	}
	for in, want := range cases {
		if got := mapEvolutionStateToStatus(in); got != want {
			t.Errorf("mapEvolutionStateToStatus(%q) = %q, want %q", in, got, want)
		}
	}
}
