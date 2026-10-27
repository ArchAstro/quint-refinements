module github.com/ArchAstro/quint-refinements/examples/go/bank_account

go 1.22

require github.com/ArchAstro/quint-refinements/bindings/go v0.0.0

// Resolve the runtime to this checkout. A real project drops this line and
// requires a released version.
replace github.com/ArchAstro/quint-refinements/bindings/go => ../../../bindings/go
