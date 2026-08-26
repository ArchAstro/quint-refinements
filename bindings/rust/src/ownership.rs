use serde::Serialize;

use crate::Error;

/// Stable identifier for one named implementation primitive.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct PrimitiveId(&'static str);

impl PrimitiveId {
    /// Creates a stable primitive identifier.
    #[must_use]
    pub const fn new(value: &'static str) -> Self {
        Self(value)
    }

    /// Returns the identifier string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

/// Compile-time record: one implementation command and the Quint actions it refines.
///
/// `refines` is the ordered spec tape of **one** impl execution. Length 1 is a
/// normal command. Length N is one source command that takes N spec steps
/// without yielding (the only legal 1-to-N model).
///
/// `aliases` are extra JSON names for a 1-step refine. They are forbidden when
/// `refines` is a sequence.
///
/// `actions` is the legacy independent-name list (each name is its own 1-step
/// run). Prefer `refines` for new records.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct OwnershipRecord {
    /// Stable identifier of the implementation command.
    pub primitive: PrimitiveId,
    /// Ordered model actions refined by one command execution.
    pub refines: &'static [&'static str],
    /// Alternate generated names for a one-step action.
    pub aliases: &'static [&'static str],
    /// Legacy independent action names retained for compatibility.
    pub actions: &'static [&'static str],
    /// Observation paths the primitive makes available.
    pub observations: &'static [&'static str],
    /// Expression dependencies the primitive can retrieve.
    pub retrieve: &'static [&'static str],
}

/// One package's exported ownership slice.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OwnershipTable {
    /// Package or module that exports the records.
    pub owner: &'static str,
    /// Compile-time ownership records exported by the owner.
    pub descriptors: &'static [OwnershipRecord],
}

/// Runtime copy of an ownership record with an owning package name.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct OwnershipDescriptor {
    /// Package or module that exported the record.
    pub owner: String,
    /// Stable identifier of the implementation command.
    pub primitive: String,
    /// Ordered model actions refined by one execution.
    pub refines: Vec<String>,
    /// Alternate generated names for a one-step action.
    pub aliases: Vec<String>,
    /// All independently covered names used by compatibility reporting.
    pub actions: Vec<String>,
    /// Observation paths made available by the command.
    pub observations: Vec<String>,
    /// Expression dependencies the command can retrieve.
    pub retrieve: Vec<String>,
}

/// Why deterministic descriptor aggregation failed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AggregationError {
    /// An owner exported an empty implementation identifier.
    EmptyPrimitiveId {
        /// Owner that exported the invalid record.
        owner: &'static str,
    },
    /// More than one owner exported the same primitive identifier.
    DuplicatePrimitiveId(String),
    /// A compound sequence declared aliases, which are only valid for one-step actions.
    AliasesOnCompoundSequence {
        /// Primitive containing the invalid declaration.
        primitive: String,
    },
}

impl std::fmt::Display for AggregationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyPrimitiveId { owner } => {
                write!(
                    formatter,
                    "ownership record owned by {owner} has an empty primitive ID"
                )
            }
            Self::DuplicatePrimitiveId(implementation) => write!(
                formatter,
                "primitive ID {implementation} is declared more than once"
            ),
            Self::AliasesOnCompoundSequence { primitive } => write!(
                formatter,
                "primitive {primitive} refines a sequence and cannot declare aliases"
            ),
        }
    }
}

impl std::error::Error for AggregationError {}

impl From<AggregationError> for Error {
    fn from(error: AggregationError) -> Self {
        Self::new(error.to_string())
    }
}

fn coverage_actions(record: &OwnershipRecord) -> Vec<String> {
    let mut names = Vec::new();
    for name in record
        .refines
        .iter()
        .chain(record.aliases.iter())
        .chain(record.actions.iter())
    {
        if !names.iter().any(|existing| existing == *name) {
            names.push((*name).to_owned());
        }
    }
    names
}

/// Validates and sorts explicit ownership tables by primitive identifier.
pub fn collect_ownership_records(
    tables: &[OwnershipTable],
) -> Result<Vec<OwnershipDescriptor>, AggregationError> {
    let mut descriptors = Vec::new();
    for table in tables {
        for descriptor in table.descriptors {
            if descriptor.primitive.as_str().trim().is_empty() {
                return Err(AggregationError::EmptyPrimitiveId { owner: table.owner });
            }
            if descriptor.refines.len() > 1 && !descriptor.aliases.is_empty() {
                return Err(AggregationError::AliasesOnCompoundSequence {
                    primitive: descriptor.primitive.as_str().to_owned(),
                });
            }
            descriptors.push(OwnershipDescriptor {
                owner: table.owner.to_owned(),
                primitive: descriptor.primitive.as_str().to_owned(),
                refines: descriptor
                    .refines
                    .iter()
                    .map(|value| (*value).to_owned())
                    .collect(),
                aliases: descriptor
                    .aliases
                    .iter()
                    .map(|value| (*value).to_owned())
                    .collect(),
                actions: coverage_actions(descriptor),
                observations: descriptor
                    .observations
                    .iter()
                    .map(|value| (*value).to_owned())
                    .collect(),
                retrieve: descriptor
                    .retrieve
                    .iter()
                    .map(|value| (*value).to_owned())
                    .collect(),
            });
        }
    }
    descriptors.sort_unstable_by(|left, right| left.primitive.cmp(&right.primitive));
    for pair in descriptors.windows(2) {
        if pair[0].primitive == pair[1].primitive {
            return Err(AggregationError::DuplicatePrimitiveId(
                pair[0].primitive.clone(),
            ));
        }
    }
    Ok(descriptors)
}

/// Declares one named, compile-time-only ownership record.
///
/// Use `refines` for the ordered spec steps of one impl command. Use `aliases`
/// only when that command is 1-step and JSON may use another name.
#[macro_export]
macro_rules! quint_ownership {
    (
        $(#[$meta:meta])*
        $visibility:vis const $name:ident = {
            primitive: $primitive:literal,
            refines: [$($step:literal),* $(,)?],
            aliases: [$($alias:literal),* $(,)?],
            observations: [$($observation:literal),* $(,)?],
            retrieve: [$($retrieve:literal),* $(,)?],
        };
    ) => {
        $(#[$meta])*
        $visibility const $name: $crate::OwnershipRecord =
            $crate::OwnershipRecord {
                primitive: $crate::PrimitiveId::new($primitive),
                refines: &[$($step),*],
                aliases: &[$($alias),*],
                actions: &[],
                observations: &[$($observation),*],
                retrieve: &[$($retrieve),*],
            };
    };
    (
        $(#[$meta:meta])*
        $visibility:vis const $name:ident = {
            primitive: $primitive:literal,
            refines: [$($step:literal),* $(,)?],
            aliases: [$($alias:literal),* $(,)?],
            observations: [$($observation:literal),* $(,)?],
        };
    ) => {
        $crate::quint_ownership! {
            $(#[$meta])*
            $visibility const $name = {
                primitive: $primitive,
                refines: [$($step),*],
                aliases: [$($alias),*],
                observations: [$($observation),*],
                retrieve: [],
            };
        }
    };
    (
        $(#[$meta:meta])*
        $visibility:vis const $name:ident = {
            primitive: $primitive:literal,
            refines: [$($step:literal),* $(,)?],
            observations: [$($observation:literal),* $(,)?],
            retrieve: [$($retrieve:literal),* $(,)?],
        };
    ) => {
        $crate::quint_ownership! {
            $(#[$meta])*
            $visibility const $name = {
                primitive: $primitive,
                refines: [$($step),*],
                aliases: [],
                observations: [$($observation),*],
                retrieve: [$($retrieve),*],
            };
        }
    };
    (
        $(#[$meta:meta])*
        $visibility:vis const $name:ident = {
            primitive: $primitive:literal,
            refines: [$($step:literal),* $(,)?],
            observations: [$($observation:literal),* $(,)?],
        };
    ) => {
        $crate::quint_ownership! {
            $(#[$meta])*
            $visibility const $name = {
                primitive: $primitive,
                refines: [$($step),*],
                aliases: [],
                observations: [$($observation),*],
                retrieve: [],
            };
        }
    };
    (
        $(#[$meta:meta])*
        $visibility:vis const $name:ident = {
            primitive: $primitive:literal,
            actions: [$($action:literal),* $(,)?],
            observations: [$($observation:literal),* $(,)?],
            retrieve: [$($retrieve:literal),* $(,)?],
        };
    ) => {
        $(#[$meta])*
        $visibility const $name: $crate::OwnershipRecord =
            $crate::OwnershipRecord {
                primitive: $crate::PrimitiveId::new($primitive),
                refines: &[],
                aliases: &[],
                actions: &[$($action),*],
                observations: &[$($observation),*],
                retrieve: &[$($retrieve),*],
            };
    };
    (
        $(#[$meta:meta])*
        $visibility:vis const $name:ident = {
            primitive: $primitive:literal,
            actions: [$($action:literal),* $(,)?],
            observations: [$($observation:literal),* $(,)?],
        };
    ) => {
        $crate::quint_ownership! {
            $(#[$meta])*
            $visibility const $name = {
                primitive: $primitive,
                actions: [$($action),*],
                observations: [$($observation),*],
                retrieve: [],
            };
        }
    };
}
