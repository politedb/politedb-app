import { TargetedEvent } from "preact";
import { useMemo, useState } from "preact/hooks";
import { useController, useWatch } from "react-hook-form";
import { Field, Input } from "src/components/form";
import { toNumber } from "src/utils/convert";
import { SSLSection } from "./SSLSection";
import type { SectionProps } from "./connectionForm.utils";

type InputEvt = TargetedEvent<HTMLInputElement>;

export function ConnectionBasicsSection(
  props: SectionProps & { isCreateNewConnection: boolean }
) {
  const { control, errors, onDirty, isCreateNewConnection } = props;

  const engine = useWatch({ control, name: "engine" });
  const isRedis = engine === "redis";
  const isMongo = engine === "mongo";
  const isSqlite = engine === "sqlite";
  const isD1 = engine === "d1";
  const isSnowflake = engine === "snowflake";
  const isFilelessSql = isSqlite || isD1 || isSnowflake;

  // storeKeychain needs to be controlled (for radio)
  const storeKeychainCtl = useController({
    control,
    name: "storeKeychain",
    defaultValue: true as any,
  });
  const storeKeychain = useWatch({ control, name: "storeKeychain" });

  const name = useController({
    control,
    name: "name",
    rules: { required: "Name is required." },
  });

  const host = useController({
    control,
    name: "host",
    rules: {
      validate: (v) => {
        if (isFilelessSql) return true;
        return String(v ?? "").trim().length > 0 || "Host is required.";
      },
    },
  });

  const port = useController({
    control,
    name: "port",
    rules: {
      required: "Port is required.",
      validate: (v) => {
        if (isFilelessSql) return true;
        const n = Number(v);
        if (!Number.isFinite(n)) return "Port is invalid.";
        if (n <= 0 || n > 65535) return "Port must be 1..65535.";
        return true;
      },
    },
  });

  const database = useController({
    control,
    name: "database",
    rules: {
      validate: (v) => {
        if (isSqlite) {
          return (
            String(v ?? "").trim().length > 0 ||
            "Database file path is required."
          );
        }
        if (isD1) {
          return (
            String(v ?? "").trim().length > 0 || "Database ID is required."
          );
        }
        if (isSnowflake) {
          return (
            String(v ?? "").trim().length > 0 || "Database name is required."
          );
        }
        return true;
      },
    },
  });

  const user = useController({
    control,
    name: "user",
    rules: {
      validate: (v) => {
        if (isRedis || isMongo || isFilelessSql) return true;
        return String(v ?? "").trim().length > 0 || "User is required.";
      },
    },
  });

  // Password: required ONLY when storeKeychain=false
  const password = useController({
    control,
    name: "password",
    rules: {
      validate: (v) => {
        if (isRedis || isMongo || isSqlite) return true;
        if (isD1) {
          return String(v ?? "").trim().length > 0 || "API token is required.";
        }
        if (storeKeychain) return true;
        return String(v ?? "").trim().length > 0 || "Password is required.";
      },
    },
  });

  const snowflakeWarehouse = useController({
    control,
    name: "snowflakeWarehouse",
    rules: {
      validate: (v) => {
        if (!isSnowflake) return true;
        return String(v ?? "").trim().length > 0 || "Warehouse is required.";
      },
    },
  });

  const snowflakeRole = useController({ control, name: "snowflakeRole" });
  const snowflakeSchema = useController({ control, name: "snowflakeSchema" });

  const sslMode = useController({ control, name: "sslMode" });
  const sslKey = useController({ control, name: "sslKey" });
  const sslCert = useController({ control, name: "sslCert" });
  const sslCA = useController({ control, name: "sslCA" });

  const [showPassword, setShowPassword] = useState(false);
  const [editingPassword, setEditingPassword] = useState(isCreateNewConnection);

  function dirty() {
    onDirty?.();
  }

  // Keychain saved => password value empty AND user is not editing a new password
  const shouldShowMasked = useMemo(() => {
    const v = String(password.field.value ?? "");
    return !!storeKeychain && v.length === 0 && !editingPassword;
  }, [storeKeychain, password.field.value, editingPassword]);

  const showTogglePassword = useMemo(() => {
    const v = String(password.field.value ?? "");
    return v.trim().length > 0;
  }, [password.field.value]);

  const defaultPort = useMemo(() => {
    if (engine === "mysql" || engine === "mariadb") return 3306;
    if (engine === "sqlserver") return 1433;
    if (engine === "mongo") return 27017;
    if (engine === "redis") return 6379;
    if (engine === "sqlite" || engine === "d1" || engine === "snowflake")
      return 0;
    return 5432;
  }, [engine]);

  const nameErr = !!errors?.name;
  const hostErr = !!errors?.host;
  const portErr = !!errors?.port;
  const dbErr = !isMongo && !!errors?.database;
  const userErr = !isMongo && !isFilelessSql && !!errors?.user;
  const pwErr =
    !storeKeychain &&
    !isRedis &&
    !isMongo &&
    !isSqlite &&
    (isD1 || !!errors?.password);

  return (
    <section class="rounded-2xl border border-slate-200 bg-white p-5">
      <div class="mb-4 flex items-center justify-between">
        <div class="text-sm font-semibold text-slate-900">
          Connection basics
        </div>
        <div class="text-xs text-slate-500">
          {isSqlite
            ? "SQLite file path"
            : isD1
              ? "Cloudflare account, database, API token"
              : isSnowflake
                ? "Account, warehouse, database, user"
                : isRedis || isMongo
                  ? "Host, Port"
                  : "Host, Port, User (database optional)"}
        </div>
      </div>

      <div class="space-y-4">
        <Field label="Name">
          <Input
            value={name.field.value}
            placeholder="Local Postgres, Production DB..."
            error={nameErr}
            onInput={(e: InputEvt) => {
              name.field.onChange(e.currentTarget.value);
              dirty();
            }}
          />
        </Field>

        {isD1 ? (
          <>
            <Field label="Account ID">
              <Input
                value={host.field.value}
                placeholder="Cloudflare account ID"
                error={hostErr}
                onInput={(e: InputEvt) => {
                  host.field.onChange(e.currentTarget.value);
                  dirty();
                }}
              />
            </Field>
            <Field label="Database ID">
              <Input
                value={database.field.value}
                placeholder="D1 database UUID"
                error={dbErr}
                onInput={(e: InputEvt) => {
                  database.field.onChange(e.currentTarget.value);
                  dirty();
                }}
              />
            </Field>
          </>
        ) : null}

        {isSnowflake ? (
          <>
            <Field label="Account">
              <Input
                value={host.field.value}
                placeholder="xy12345.us-east-1"
                error={hostErr}
                onInput={(e: InputEvt) => {
                  host.field.onChange(e.currentTarget.value);
                  dirty();
                }}
              />
            </Field>
            <Field label="Warehouse">
              <Input
                value={snowflakeWarehouse.field.value}
                placeholder="COMPUTE_WH"
                error={!!errors?.snowflakeWarehouse}
                onInput={(e: InputEvt) => {
                  snowflakeWarehouse.field.onChange(e.currentTarget.value);
                  dirty();
                }}
              />
            </Field>
            <Field label="DB / Schema" alignTop>
              <div class="grid grid-cols-2 gap-3">
                <Input
                  value={database.field.value}
                  placeholder="MY_DATABASE"
                  error={dbErr}
                  onInput={(e: InputEvt) => {
                    database.field.onChange(e.currentTarget.value);
                    dirty();
                  }}
                />
                <Input
                  value={snowflakeSchema.field.value}
                  placeholder="PUBLIC"
                  onInput={(e: InputEvt) => {
                    snowflakeSchema.field.onChange(e.currentTarget.value);
                    dirty();
                  }}
                />
              </div>
            </Field>
            <Field label="User / Role" alignTop>
              <div class="grid grid-cols-2 gap-3">
                <Input
                  value={user.field.value}
                  placeholder="username"
                  error={userErr}
                  onInput={(e: InputEvt) => {
                    user.field.onChange(e.currentTarget.value);
                    dirty();
                  }}
                />
                <Input
                  value={snowflakeRole.field.value}
                  placeholder="ACCOUNTADMIN (optional)"
                  onInput={(e: InputEvt) => {
                    snowflakeRole.field.onChange(e.currentTarget.value);
                    dirty();
                  }}
                />
              </div>
            </Field>
          </>
        ) : null}

        {!isFilelessSql && (
          <Field label="Host / Port" alignTop>
            <div class="grid grid-cols-3 gap-3">
              <Input
                class="col-span-2"
                value={host.field.value}
                placeholder="127.0.0.1 or /tmp/..."
                error={hostErr}
                onInput={(e: InputEvt) => {
                  host.field.onChange(e.currentTarget.value);
                  dirty();
                }}
              />
              <Input
                value={String(port.field.value ?? "")}
                inputMode="numeric"
                placeholder={String(defaultPort)}
                error={portErr}
                onInput={(e: InputEvt) => {
                  port.field.onChange(
                    toNumber(e.currentTarget.value, defaultPort)
                  );
                  dirty();
                }}
              />
            </div>
          </Field>
        )}

        {!isD1 && !isSnowflake ? (
          <Field
            label={
              isSqlite ? "Database Path" : isRedis ? "User" : "Database / User"
            }
            alignTop
          >
            <div
              class={
                isSqlite ? "grid grid-cols-1 gap-3" : "grid grid-cols-2 gap-3"
              }
            >
              {!isRedis && (
                <Input
                  value={database.field.value}
                  placeholder={
                    isSqlite ? "/absolute/path/to/file.db" : "database"
                  }
                  error={dbErr}
                  class={isSqlite ? "col-span-2" : ""}
                  onInput={(e: InputEvt) => {
                    database.field.onChange(e.currentTarget.value);
                    dirty();
                  }}
                />
              )}
              {!isSqlite && (
                <Input
                  value={user.field.value}
                  placeholder="user"
                  error={userErr}
                  class={isRedis ? "col-span-2" : ""}
                  onInput={(e: InputEvt) => {
                    user.field.onChange(e.currentTarget.value);
                    dirty();
                  }}
                />
              )}
            </div>
          </Field>
        ) : null}

        {/* Password + Storage (merged) */}
        {!isSqlite && (
          <Field label={isD1 ? "API Token" : "Password"} alignTop>
            <div class="space-y-2">
              {/* Password row */}
              {shouldShowMasked ? (
                <div class="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-semibold text-slate-700">
                      ••••••••
                    </span>
                    <span class="text-xs text-slate-500">
                      Saved in Keychain
                    </span>
                  </div>

                  <button
                    type="button"
                    class="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    title="Replace password"
                    onClick={() => {
                      setEditingPassword(true);
                      setShowPassword(false);
                      // keep password empty; user will type a new one
                      dirty();
                    }}
                  >
                    Replace
                  </button>
                </div>
              ) : (
                <div class="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    value={password.field.value}
                    error={pwErr}
                    placeholder={
                      storeKeychain
                        ? "Enter password (save in Keychain)"
                        : "Enter password (not saved)"
                    }
                    onInput={(e: InputEvt) => {
                      password.field.onChange(e.currentTarget.value);
                      dirty();
                    }}
                    class="pr-12"
                  />

                  {showTogglePassword ? (
                    <button
                      type="button"
                      onClick={() => setShowPassword((x) => !x)}
                      class="absolute top-1/2 right-2 -translate-y-1/2 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                      title={showPassword ? "Hide" : "Show"}
                    >
                      {showPassword ? "Hide" : "Show"}
                    </button>
                  ) : null}
                </div>
              )}

              {/* Storage radio */}
              <div
                class={`flex flex-wrap items-center gap-4 rounded-xl border px-3 py-2 ${
                  storeKeychain
                    ? "border-slate-200 bg-white"
                    : "border-slate-200 bg-white"
                }`}
              >
                <label class="flex items-center gap-2 text-sm text-slate-700 hover:text-slate-700/80">
                  <input
                    type="radio"
                    name="password-storage"
                    checked={!!storeKeychain}
                    onChange={() => {
                      storeKeychainCtl.field.onChange(true);
                      // if switching to keychain, user might keep password empty to mean "keep existing"
                      dirty();
                    }}
                  />
                  Save in Keychain
                </label>

                <label class="flex items-center gap-2 text-sm text-slate-700 hover:text-slate-700/80">
                  <input
                    type="radio"
                    name="password-storage"
                    checked={!storeKeychain}
                    onChange={() => {
                      storeKeychainCtl.field.onChange(false);

                      // If they turn off keychain while we were masked, force editing mode
                      // because we now need an inline password to test/connect.
                      if (shouldShowMasked) {
                        setEditingPassword(true);
                        setShowPassword(false);
                      }

                      dirty();
                    }}
                  />
                  Do not save
                </label>

                <div class="w-full text-xs leading-snug text-slate-500">
                  {storeKeychain ? (
                    <>
                      Stored securely in OS keychain. You can leave password
                      empty to keep the existing one.
                    </>
                  ) : (
                    <>
                      Password is used for this session only and will not be
                      saved.
                    </>
                  )}
                </div>
              </div>
            </div>
          </Field>
        )}

        {!isSqlite && !isSnowflake && (
          <SSLSection
            sslMode={sslMode.field.value}
            sslKey={sslKey.field.value}
            sslCert={sslCert.field.value}
            sslCA={sslCA.field.value}
            onChangeSslMode={(m) => {
              sslMode.field.onChange(m);
              dirty();
            }}
            onChangeSslKey={(v) => {
              sslKey.field.onChange(v);
              dirty();
            }}
            onChangeSslCert={(v) => {
              sslCert.field.onChange(v);
              dirty();
            }}
            onChangeSslCA={(v) => {
              sslCA.field.onChange(v);
              dirty();
            }}
          />
        )}
      </div>
    </section>
  );
}
