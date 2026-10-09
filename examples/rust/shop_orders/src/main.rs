mod generated_refinement;

use std::collections::{BTreeMap, BTreeSet};

use generated_refinement::{Implementation, refine_all};
use quint_refinements::{NormalizedRuntimeEvidence, RuntimeValue};

/// The code under test.
#[derive(Default)]
struct Shop {
    paid: BTreeSet<String>,
    revenue: i64,
}

impl Shop {
    fn pay(&mut self, id: &str, total: i64) -> Result<(), String> {
        if !self.paid.insert(id.to_owned()) {
            return Err(format!("order {id} is already paid"));
        }
        self.revenue += total;
        Ok(())
    }

    fn refund(&mut self, id: &str, total: i64) {
        if self.paid.remove(id) {
            self.revenue -= total;
        }
    }
}

/// What the checker may observe: the model's `state` record.
#[derive(Clone)]
struct Snapshot {
    paid: BTreeSet<String>,
    revenue: i64,
}

impl NormalizedRuntimeEvidence for Snapshot {
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String> {
        match name {
            "state" => Ok(RuntimeValue::Record(BTreeMap::from([
                (
                    "paid".to_owned(),
                    RuntimeValue::Set(self.paid.iter().cloned().map(RuntimeValue::Text).collect()),
                ),
                ("revenue".to_owned(), RuntimeValue::Int(self.revenue)),
            ]))),
            other => Err(format!("unknown model name {other}")),
        }
    }

    fn resolve_call(
        &self,
        _operator: &str,
        _arguments: &[RuntimeValue],
    ) -> Option<Result<RuntimeValue, String>> {
        None
    }
}

/// Reads the `Order` record the model passes to `pay` and `refund`.
fn order(arguments: &[RuntimeValue]) -> Result<(&str, i64), String> {
    let [RuntimeValue::Record(order)] = arguments else {
        return Err(format!("expected one order record: {arguments:?}"));
    };
    match (order.get("id"), order.get("total")) {
        (Some(RuntimeValue::Text(id)), Some(RuntimeValue::Int(total))) => Ok((id, *total)),
        _ => Err(format!(
            "order needs a text id and an integer total: {order:?}"
        )),
    }
}

impl Implementation for Shop {
    type Evidence = Snapshot;

    fn from_initial_state(_initial_state: &RuntimeValue) -> Result<Self, String> {
        Ok(Self::default())
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            paid: self.paid.clone(),
            revenue: self.revenue,
        }
    }

    fn pay(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let (id, total) = order(arguments)?;
        self.pay(id, total)
    }

    fn refund(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let (id, total) = order(arguments)?;
        self.refund(id, total);
        Ok(())
    }
}

fn main() {
    match refine_all::<Shop>() {
        Ok(results) => {
            for result in results {
                println!(
                    "{} refined {} obligations",
                    result.scenario, result.evaluated_obligations
                );
            }
        }
        Err(error) => {
            eprintln!("refinement failed: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Shop, refine_all};

    #[test]
    fn shop_refines_every_quint_scenario() {
        if let Err(error) = refine_all::<Shop>() {
            panic!("refinement failed: {error}");
        }
    }
}
