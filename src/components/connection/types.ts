import { Control, FieldErrors } from "react-hook-form";
import type { ClickHouseProtocol, SslMode } from "src/lib/tauri";
import type { DatabaseEngine } from "src/types";

export type FormValues = {
  engine: DatabaseEngine;
  name: string;

  tags: string[];
  indicator_color: string;

  host: string;
  port: number;
  user: string;
  password: string;
  database: string;

  snowflakeWarehouse: string;
  snowflakeRole: string;
  snowflakeSchema: string;

  clickhouseProtocol: ClickHouseProtocol;

  storeKeychain: boolean;

  sslMode: SslMode;
  sslKey: string;
  sslCert: string;
  sslCA: string;

  sshAuthType: "password" | "privateKey" | "privateKeyWithPassphrase";
  sshEnabled: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshKeyPath: string;
  sshPassword: string;
  sshPasswordSaveMethod: "keychain" | "inline";
};

export type SectionProps = {
  control: Control<FormValues>;
  errors?: FieldErrors<FormValues>;
  onDirty?: () => void;
};
