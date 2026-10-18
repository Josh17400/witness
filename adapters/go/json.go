package witness

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
)

// marshal encodes v as one line of JSON. encoding/json refuses NaN and infinities; the
// protocol wants them as the strings "NaN" / "Infinity" / "-Infinity", so on that error the
// value is rewritten (once, slow path) into plain maps/slices with those strings.
func marshal(v any) ([]byte, error) {
	b, err := encode(v)
	var unsupported *json.UnsupportedValueError
	if errors.As(err, &unsupported) {
		b, err = encode(sanitize(reflect.ValueOf(v)))
	}
	return b, err
}

func encode(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

var marshalerType = reflect.TypeOf((*json.Marshaler)(nil)).Elem()

func sanitize(v reflect.Value) any {
	if !v.IsValid() {
		return nil
	}
	if v.Type().Implements(marshalerType) && (v.Kind() != reflect.Pointer || !v.IsNil()) {
		return v.Interface()
	}
	switch v.Kind() {
	case reflect.Float32, reflect.Float64:
		f := v.Float()
		switch {
		case math.IsNaN(f):
			return "NaN"
		case math.IsInf(f, 1):
			return "Infinity"
		case math.IsInf(f, -1):
			return "-Infinity"
		}
		return f
	case reflect.Interface, reflect.Pointer:
		if v.IsNil() {
			return nil
		}
		return sanitize(v.Elem())
	case reflect.Map:
		if v.IsNil() {
			return nil
		}
		out := make(map[string]any, v.Len())
		it := v.MapRange()
		for it.Next() {
			out[fmt.Sprint(it.Key().Interface())] = sanitize(it.Value())
		}
		return out
	case reflect.Slice:
		if v.IsNil() {
			return nil
		}
		if v.Type().Elem().Kind() == reflect.Uint8 {
			return v.Interface() // []byte stays base64, as encoding/json does
		}
		fallthrough
	case reflect.Array:
		out := make([]any, v.Len())
		for i := range out {
			out[i] = sanitize(v.Index(i))
		}
		return out
	case reflect.Struct:
		out := map[string]any{}
		sanitizeStruct(v, out)
		return out
	}
	return v.Interface()
}

// sanitizeStruct follows the encoding/json field rules that matter here: exported fields,
// `json:"name,omitempty"`, `json:"-"`, and embedded structs flattened into the parent.
func sanitizeStruct(v reflect.Value, out map[string]any) {
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		tag := f.Tag.Get("json")
		if tag == "-" || (!f.IsExported() && !f.Anonymous) {
			continue
		}
		name, opts, _ := strings.Cut(tag, ",")
		fv := v.Field(i)
		if f.Anonymous && name == "" {
			if fv.Kind() == reflect.Pointer {
				if fv.IsNil() {
					continue
				}
				fv = fv.Elem()
			}
			if fv.Kind() == reflect.Struct {
				sanitizeStruct(fv, out)
				continue
			}
		}
		if !f.IsExported() {
			continue
		}
		if name == "" {
			name = f.Name
		}
		if strings.Contains(opts, "omitempty") && fv.IsZero() {
			continue
		}
		out[name] = sanitize(fv)
	}
}
