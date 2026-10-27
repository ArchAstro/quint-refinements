package refinements

import (
	"bytes"
	"encoding/json"
	"io"
	"sort"
)

// decodeJSON parses one JSON document, keeping numbers as json.Number.
func decodeJSON(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errorf("trailing characters after JSON document")
	}
	return value, nil
}

// jsonString renders a decoded JSON value compactly with sorted object keys,
// the way serde_json's Display does.
func jsonString(value any) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "null"
	}
	return string(bytes.TrimRight(buffer.Bytes(), "\n"))
}

// normalizeJSON round-trips any marshalable value into the decoded form the
// artifact uses, so equality is independent of Go's static types.
func normalizeJSON(value any) (any, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return decodeJSON(buffer.Bytes())
}

func jsonObject(value any) (map[string]any, bool) {
	object, ok := value.(map[string]any)
	return object, ok
}

// jsonField reads object[key], yielding nil when value is not an object, like
// serde_json's Index on Value.
func jsonField(value any, key string) any {
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return object[key]
}

func jsonKind(value any) (string, bool) {
	text, ok := jsonField(value, "kind").(string)
	return text, ok
}

func sortedObjectKeys(object map[string]any) []string {
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func bytesReader(data []byte) *bytes.Reader { return bytes.NewReader(data) }

func sortedRawKeys(fields map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
