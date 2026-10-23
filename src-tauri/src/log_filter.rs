//! Log filter for the app's tracing subscriber.
//!
//! `RUST_LOG` chooses what is logged, except for database drivers that put
//! user data in their records: tokio-postgres logs every prepared or simple
//! query's text at debug level and every server NOTICE (which functions can
//! fill with row data) at info level. Those targets are capped at `warn`
//! whatever `RUST_LOG` says, so SQL text and notices never reach the logs.
//! `log` records (tokio-postgres uses `log`) are bridged into tracing by the
//! subscriber's `init()` with their own targets, so the same filter applies.

use tracing::{Level, Metadata, Subscriber};
use tracing_subscriber::filter::{filter_fn, FilterExt};
use tracing_subscriber::layer::Filter;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::EnvFilter;

/// Driver targets whose debug/info records carry SQL or server text.
const SENSITIVE_TARGETS: &[&str] = &["tokio_postgres"];

fn is_sensitive(meta: &Metadata<'_>) -> bool {
    // In tracing, a more verbose level compares greater (TRACE > WARN).
    *meta.level() > Level::WARN
        && SENSITIVE_TARGETS.iter().any(|target| {
            meta.target() == *target
                || meta
                    .target()
                    .strip_prefix(target)
                    .is_some_and(|rest| rest.starts_with("::"))
        })
}

/// `env`, except that sensitive driver records below warn are always
/// dropped. A separate hard filter, so no `RUST_LOG` directive (however
/// specific its target) can re-enable them.
pub fn capped<S>(env: EnvFilter) -> impl Filter<S>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    env.and(filter_fn(|meta| !is_sensitive(meta)))
}

/// Filter from `RUST_LOG`, with the caps applied.
pub fn from_env<S>() -> impl Filter<S>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    capped(EnvFilter::from_default_env())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::fmt::MakeWriter;
    use tracing_subscriber::prelude::*;

    #[derive(Clone, Default)]
    struct Buffer(Arc<Mutex<Vec<u8>>>);

    impl Write for Buffer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for Buffer {
        type Writer = Buffer;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    fn logged_with(env: &str, emit: impl FnOnce()) -> String {
        let buffer = Buffer::default();
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_writer(buffer.clone())
                .with_ansi(false)
                .with_filter(capped(EnvFilter::new(env))),
        );
        tracing::subscriber::with_default(subscriber, emit);
        let bytes = buffer.0.lock().unwrap().clone();
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn driver_sql_and_notices_are_dropped_even_at_trace() {
        for env in [
            "trace",
            "debug,tokio_postgres=trace",
            "debug,tokio_postgres::prepare=debug",
            "debug,tokio_postgres::connection=trace",
        ] {
            let out = logged_with(env, || {
                tracing::debug!(target: "tokio_postgres::prepare", "preparing query s1: select 'secret-sql'");
                tracing::info!(target: "tokio_postgres::connection", "NOTICE: customer secret-notice");
                tracing::warn!(target: "tokio_postgres::connection", "driver warning kept");
                tracing::debug!(target: "PoliteDB::engines", "app debug kept");
            });
            assert!(!out.contains("secret-sql"), "{env}: {out}");
            assert!(!out.contains("secret-notice"), "{env}: {out}");
            assert!(out.contains("driver warning kept"), "{env}: {out}");
            assert!(out.contains("app debug kept"), "{env}: {out}");
        }
    }

    /// tokio-postgres logs through `log`; the bridge keeps its targets.
    #[test]
    fn bridged_log_records_are_filtered_too() {
        let _ = tracing_log::LogTracer::init();
        let out = logged_with("trace", || {
            log::debug!(target: "tokio_postgres::prepare", "preparing query s1: select 'secret-sql'");
            log::info!(target: "tokio_postgres::connection", "NOTICE: customer secret-notice");
            log::warn!(target: "tokio_postgres::connection", "driver warning kept");
        });
        assert!(!out.contains("secret-sql"), "{out}");
        assert!(!out.contains("secret-notice"), "{out}");
        assert!(out.contains("driver warning kept"), "{out}");
    }
}
