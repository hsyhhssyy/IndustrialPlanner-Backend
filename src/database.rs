use sqlx::{
    MySqlPool,
    mysql::MySqlPoolOptions,
    postgres::{PgPool, PgPoolOptions},
};
use thiserror::Error;

#[derive(Clone)]
pub(crate) enum DatabasePool {
    Postgres(PgPool),
    MySql(MySqlPool),
}

impl DatabasePool {
    pub(crate) async fn connect(
        database_url: &str,
        max_connections: u32,
    ) -> Result<Self, DatabaseConnectionError> {
        match database_driver(database_url)? {
            DatabaseDriver::Postgres => Ok(Self::Postgres(
                PgPoolOptions::new()
                    .max_connections(max_connections)
                    .connect(database_url)
                    .await?,
            )),
            DatabaseDriver::MySql => Ok(Self::MySql(
                MySqlPoolOptions::new()
                    .max_connections(max_connections)
                    .connect(database_url)
                    .await?,
            )),
        }
    }

    pub(crate) async fn migrate(&self) -> Result<(), sqlx::migrate::MigrateError> {
        match self {
            Self::Postgres(pool) => {
                static POSTGRES_MIGRATOR: sqlx::migrate::Migrator =
                    sqlx::migrate!("./migrations/postgres");
                POSTGRES_MIGRATOR.run(pool).await
            }
            Self::MySql(pool) => {
                static MYSQL_MIGRATOR: sqlx::migrate::Migrator =
                    sqlx::migrate!("./migrations/mysql");
                MYSQL_MIGRATOR.run(pool).await
            }
        }
    }

    pub(crate) async fn health_check(&self) -> Result<(), sqlx::Error> {
        match self {
            Self::Postgres(pool) => {
                sqlx::query("SELECT 1").execute(pool).await?;
            }
            Self::MySql(pool) => {
                sqlx::query("SELECT 1").execute(pool).await?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Error)]
pub(crate) enum DatabaseConnectionError {
    #[error("DATABASE_URL must use postgres://, postgresql://, or mysql://")]
    UnsupportedUrl,
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
}

#[derive(Clone, Copy)]
enum DatabaseDriver {
    Postgres,
    MySql,
}

fn database_driver(database_url: &str) -> Result<DatabaseDriver, DatabaseConnectionError> {
    let scheme = database_url
        .split_once("://")
        .map(|(scheme, _)| scheme.to_ascii_lowercase());

    match scheme.as_deref() {
        Some("postgres") | Some("postgresql") => Ok(DatabaseDriver::Postgres),
        Some("mysql") => Ok(DatabaseDriver::MySql),
        _ => Err(DatabaseConnectionError::UnsupportedUrl),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_supported_database_url_schemes() {
        assert!(matches!(
            database_driver("postgres://localhost/database"),
            Ok(DatabaseDriver::Postgres)
        ));
        assert!(matches!(
            database_driver("postgresql://localhost/database"),
            Ok(DatabaseDriver::Postgres)
        ));
        assert!(matches!(
            database_driver("mysql://localhost/database"),
            Ok(DatabaseDriver::MySql)
        ));
    }

    #[test]
    fn rejects_unsupported_database_url_schemes() {
        assert!(matches!(
            database_driver("sqlite://database.db"),
            Err(DatabaseConnectionError::UnsupportedUrl)
        ));
    }
}
