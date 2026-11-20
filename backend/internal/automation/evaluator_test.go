package automation

import (
	"testing"
)

func TestEvaluateConditions_EmptyAndDefaults(t *testing.T) {
	cases := [][]byte{nil, []byte(""), []byte("null"), []byte("{}"), []byte("[]")}
	for i, c := range cases {
		ok, err := EvaluateConditions(c, map[string]any{"body": "hola"})
		if err != nil {
			t.Fatalf("case %d unexpected err: %v", i, err)
		}
		if !ok {
			t.Fatalf("case %d expected true for empty conditions", i)
		}
	}
}

func TestEvaluateConditions_Operators(t *testing.T) {
	ctx := map[string]any{
		"body":        "Quiero información sobre precios VIP",
		"source":      "whatsapp",
		"value_cents": 15000,
		"tags":        []string{"vip", "inbound"},
		"contact": map[string]any{
			"tier":  "gold",
			"email": "ana@example.com",
		},
	}

	tests := []struct {
		name string
		cond string
		want bool
	}{
		{"eq match", `{"field":"source","op":"eq","value":"whatsapp"}`, true},
		{"eq mismatch", `{"field":"source","op":"eq","value":"web"}`, false},
		{"neq match", `{"field":"source","op":"neq","value":"web"}`, true},
		{"neq mismatch", `{"field":"source","op":"neq","value":"whatsapp"}`, false},
		{"contains string", `{"field":"body","op":"contains","value":"precios"}`, true},
		{"contains slice", `{"field":"tags","op":"contains","value":"vip"}`, true},
		{"contains miss", `{"field":"body","op":"contains","value":"cancelar"}`, false},
		{"gt match", `{"field":"value_cents","op":"gt","value":10000}`, true},
		{"gt miss", `{"field":"value_cents","op":"gt","value":20000}`, false},
		{"lt match", `{"field":"value_cents","op":"lt","value":20000}`, true},
		{"lt miss", `{"field":"value_cents","op":"lt","value":10000}`, false},
		{"in match", `{"field":"contact.tier","op":"in","value":["silver","gold"]}`, true},
		{"in miss", `{"field":"contact.tier","op":"in","value":["bronze","silver"]}`, false},
		{"exists true", `{"field":"contact.email","op":"exists","value":true}`, true},
		{"exists missing", `{"field":"contact.cpf","op":"exists","value":true}`, false},
		{"exists false on missing", `{"field":"contact.cpf","op":"exists","value":false}`, true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := EvaluateConditions([]byte(tc.cond), ctx)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestEvaluateConditions_AllAnyNestedAndShorthand(t *testing.T) {
	ctx := map[string]any{
		"source":      "whatsapp",
		"value_cents": 5000,
		"body":        "Urgente por favor",
	}

	allMatch := `{"all":[{"field":"source","op":"eq","value":"whatsapp"},{"field":"value_cents","op":"gt","value":1000}]}`
	if ok, err := EvaluateConditions([]byte(allMatch), ctx); err != nil || !ok {
		t.Fatalf("expected allMatch=true, got %v err=%v", ok, err)
	}

	allFail := `{"all":[{"field":"source","op":"eq","value":"whatsapp"},{"field":"value_cents","op":"gt","value":9999}]}`
	if ok, err := EvaluateConditions([]byte(allFail), ctx); err != nil || ok {
		t.Fatalf("expected allFail=false, got %v err=%v", ok, err)
	}

	anyMatch := `{"any":[{"field":"source","op":"eq","value":"email"},{"field":"body","op":"contains","value":"urgente"}]}`
	if ok, err := EvaluateConditions([]byte(anyMatch), ctx); err != nil || !ok {
		t.Fatalf("expected anyMatch=true, got %v err=%v", ok, err)
	}

	arrayCond := `[{"field":"source","op":"eq","value":"whatsapp"},{"field":"body","op":"contains","value":"urgente"}]`
	if ok, err := EvaluateConditions([]byte(arrayCond), ctx); err != nil || !ok {
		t.Fatalf("expected arrayCond=true, got %v err=%v", ok, err)
	}

	shorthand := `{"source":"whatsapp"}`
	if ok, err := EvaluateConditions([]byte(shorthand), ctx); err != nil || !ok {
		t.Fatalf("expected shorthand=true, got %v err=%v", ok, err)
	}
}

func TestEvaluateConditions_Errors(t *testing.T) {
	if _, err := EvaluateConditions([]byte(`{invalid`), map[string]any{}); err == nil {
		t.Fatal("expected error for invalid json")
	}
	if _, err := EvaluateConditions([]byte(`{"field":"a","op":"regex_magic","value":"x"}`), map[string]any{"a": "x"}); err == nil {
		t.Fatal("expected error for unsupported operator")
	}
}

func TestParseActions(t *testing.T) {
	raw := `[
		{"type":"create_task","config":{"title":"Llamar lead","assigned_to":"user-1"}},
		{"type":"move_stage","stage_id":"stage-2"},
		{"type":"assign_agent","user_id":"user-2"},
		{"type":"send_whatsapp","message":"Hola!"},
		{"type":"add_tag","tag":"caliente"},
		{"type":"webhook_post","config":{"url":"https://hooks.example.com/crm"}}
	]`

	actions, err := ParseActions([]byte(raw))
	if err != nil {
		t.Fatalf("ParseActions failed: %v", err)
	}
	if len(actions) != 6 {
		t.Fatalf("expected 6 actions, got %d", len(actions))
	}
	if actions[0].getString("title") != "Llamar lead" {
		t.Fatalf("unexpected task title: %q", actions[0].getString("title"))
	}
	if actions[1].getString("stage_id") != "stage-2" {
		t.Fatalf("unexpected stage_id: %q", actions[1].getString("stage_id"))
	}
	if actions[2].getString("user_id") != "user-2" {
		t.Fatalf("unexpected user_id: %q", actions[2].getString("user_id"))
	}
	if actions[3].getString("message") != "Hola!" {
		t.Fatalf("unexpected message: %q", actions[3].getString("message"))
	}
	if actions[4].getString("tag") != "caliente" {
		t.Fatalf("unexpected tag: %q", actions[4].getString("tag"))
	}
	if actions[5].getString("url") != "https://hooks.example.com/crm" {
		t.Fatalf("unexpected url: %q", actions[5].getString("url"))
	}
}
