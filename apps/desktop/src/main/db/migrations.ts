import { createHash } from 'node:crypto';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

function at(version: number, name: string, sql: string): Migration {
  return { version, name, sql, checksum: createHash('sha256').update(sql, 'utf8').digest('hex') };
}

/**
 * id 列一律 ascii/ascii_bin：服务端默认是 utf8mb4_0900_ai_ci（spec §12 实测），
 * 而 uuid 串是 ascii —— 两种 collation 混着 JOIN 会报 Illegal mix of collations，
 * 且 utf8mb4 的 CHAR(36) 索引宽度是 ascii 的四倍。生成列跟着同一个口径。
 */
const ID = 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin';

const V001 = `
CREATE TABLE IF NOT EXISTS \`_migration\` (
  \`version\` INT NOT NULL PRIMARY KEY,
  \`name\` VARCHAR(100) NOT NULL,
  \`checksum\` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`applied_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`project\` (
  \`id\` ${ID} NOT NULL PRIMARY KEY,
  \`schema_version\` INT NOT NULL,
  \`name\` VARCHAR(200) NOT NULL,
  \`unit\` VARCHAR(16) NOT NULL DEFAULT 'mm',
  -- P-5/P-6：turn 是幂等键的坐标系，seq 只保证单调。
  \`journal_turn\` BIGINT NOT NULL DEFAULT 0,
  -- P-4：过期判定全交给服务端 NOW(3)，客户端只报 TTL。
  \`lock_token\` ${ID} NULL,
  \`lock_owner\` VARCHAR(200) NULL,
  \`lock_expires_at\` DATETIME(3) NULL,
  -- spec §9「启动时若发现未合并片段走恢复流程」的信号位：开工程置 0，干净收尾置 1。
  \`clean_shutdown\` TINYINT(1) NOT NULL DEFAULT 1,
  \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`element\` (
  \`id\` ${ID} NOT NULL PRIMARY KEY,
  \`project_id\` ${ID} NOT NULL,
  -- storey 实体没有 storeyId（它自己就是层），所以这里可空。
  \`storey_id\` ${ID} NULL,
  \`kind\` VARCHAR(16) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(\`payload\`, '$.kind'))) STORED
    -- 实测（MySQL 8.0.45，tmp/plan4-t2-probe-gcol.log）：生成列不接受 \`CHARACTER SET ascii\` 这个位置
    -- —— 服务端在 CHARACTER SET 处报 ER_PARSE_ERROR。只写 COLLATE 就够：列的字符集跟着
    -- ascii_bin 推导出 ascii，information_schema 回值实测 charset=ascii / collation=ascii_bin，
    -- 于是 'wall' 与 'WALL' 在索引里就是两个值（生成列要的就是这个二进制比较口径）。
    COLLATE ascii_bin NOT NULL,
  -- MySQL 对 JSON 布尔取出来的是 'true'/'false' 串，CAST 成数字会得到 0 —— 必须显式 CASE。
  \`load_bearing\` INT GENERATED ALWAYS AS (
    CASE JSON_EXTRACT(\`payload\`, '$.loadBearing')
      WHEN CAST('true' AS JSON) THEN 1
      WHEN CAST('false' AS JSON) THEN 0
      ELSE NULL
    END) STORED,
  \`payload\` JSON NOT NULL,
  \`updated_seq\` BIGINT NOT NULL DEFAULT 0,
  KEY \`idx_project\` (\`project_id\`),
  KEY \`idx_storey_kind\` (\`storey_id\`, \`kind\`),
  KEY \`idx_project_loadbearing\` (\`project_id\`, \`load_bearing\`),
  CONSTRAINT \`fk_element_project\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- spec §8.1 点名的表，但它是 element 里 storey 行的投影（P-7）：同一事务内由 repository 写。
CREATE TABLE IF NOT EXISTS \`storey\` (
  \`id\` ${ID} NOT NULL PRIMARY KEY,
  \`project_id\` ${ID} NOT NULL,
  \`index_no\` INT NOT NULL,
  \`elevation_mm\` BIGINT NOT NULL,
  \`height_mm\` BIGINT NOT NULL,
  KEY \`idx_project_index\` (\`project_id\`, \`index_no\`),
  CONSTRAINT \`fk_storey_project\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`command_log\` (
  \`seq\` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  \`project_id\` ${ID} NOT NULL,
  \`turn\` BIGINT NOT NULL,
  \`actor\` VARCHAR(64) NOT NULL,
  \`payload\` JSON NOT NULL,
  \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY \`uk_project_turn\` (\`project_id\`, \`turn\`),
  KEY \`idx_project_seq\` (\`project_id\`, \`seq\`),
  CONSTRAINT \`fk_log_project\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`snapshot\` (
  \`seq\` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  \`project_id\` ${ID} NOT NULL,
  \`journal_turn\` BIGINT NOT NULL,
  \`schema_version\` INT NOT NULL,
  \`payload\` JSON NOT NULL,
  \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY \`uk_project_turn\` (\`project_id\`, \`journal_turn\`),
  KEY \`idx_project_seq\` (\`project_id\`, \`seq\`),
  CONSTRAINT \`fk_snapshot_project\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- spec §8.1 的描图底图（M1.8 那一档才读写）。本计划只建表，读写路径登记在交接表里（代价见 P-8 同段）。
CREATE TABLE IF NOT EXISTS \`asset\` (
  \`id\` ${ID} NOT NULL PRIMARY KEY,
  \`project_id\` ${ID} NOT NULL,
  \`kind\` VARCHAR(32) NOT NULL,
  \`path\` VARCHAR(500) NULL,
  \`blob\` LONGBLOB NULL,
  \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY \`idx_project_kind\` (\`project_id\`, \`kind\`),
  CONSTRAINT \`fk_asset_project\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

export const MIGRATIONS: readonly Migration[] = [at(1, 'init', V001)];
