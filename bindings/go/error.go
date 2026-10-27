package refinements

import "fmt"

// Error is the fail-closed error from parsing, ownership aggregation, fixture
// validation, or evaluation. Its text matches the Rust binding's diagnostics.
type Error struct {
	message string
}

// NewError creates an error with a human-readable diagnostic.
func NewError(message string) *Error {
	return &Error{message: message}
}

// Message returns the diagnostic message.
func (e *Error) Message() string { return e.message }

// Error implements the error interface.
func (e *Error) Error() string { return e.message }

func errorf(format string, args ...any) error {
	return &Error{message: fmt.Sprintf(format, args...)}
}
