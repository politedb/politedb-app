use std::sync::Arc;

use dashmap::DashMap;

use crate::types::EngineKind;

use super::driver::EngineDriver;

#[derive(Clone)]
pub struct EngineRegistry {
    drivers: Arc<DashMap<EngineKind, Arc<dyn EngineDriver>>>,
}

impl EngineRegistry {
    pub fn new(drivers: Vec<Arc<dyn EngineDriver>>) -> Self {
        let map = DashMap::new();
        for d in drivers {
            map.insert(d.kind(), d);
        }
        Self {
            drivers: Arc::new(map),
        }
    }

    pub fn get(&self, kind: EngineKind) -> Option<Arc<dyn EngineDriver>> {
        self.drivers.get(&kind).map(|r| r.value().clone())
    }
}
