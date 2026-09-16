// JSON 文件存储：写队列串行化 + 乐观版本号 + 幂等键重放 + 写失败回滚。
//
// 一致性语义：
//  - 所有变更在 read/write 事务内完成：先在内存副本上改动并校验版本，再原子落盘；
//  - 落盘失败（或测试注入失败）时丢弃内存副本、从磁盘重新加载，损伤/寿命/冻结状态
//    与未提交前完全一致（整体回滚）；
//  - expectedVersion 不匹配返回 conflict，调用方不写入；
//  - idempotencyKey 命中已提交事务时直接重放当时响应，不重复落盘；
//  - tmp+rename 原子写，进程崩溃也只会保留上一版完整文件，重启后数据仍在。

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export class Store {
  constructor(file, seedFactory) {
    this.file = file;
    this.seedFactory = seedFactory;
    this.queue = Promise.resolve();
    this.db = null;
    // 测试钩子：置为 true 时下一次物理写入抛错（触发回滚路径）
    this.failNextWrite = false;
  }

  async init() {
    if (!existsSync(this.file)) {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(this.seedFactory(), null, 2));
    }
    this.db = JSON.parse(await readFile(this.file, "utf8"));
    this.db.version ??= 1;
    this.db.idempotency ??= {};
    this.db.items ??= [];
    this.db.masts ??= [];
    return this.db;
  }

  // 只读快照（深拷贝，避免调用方绕过事务修改内存）
  async read() {
    const db = await this.ready();
    return JSON.parse(JSON.stringify(db));
  }

  async ready() {
    if (!this.db) await this.init();
    return this.db;
  }

  // 串行执行变更；同一时刻只有一个 mutator 在跑，彻底消除并发交叉写。
  mutate({ expectedVersion, idempotencyKey }, mutator) {
    const result = this.queue.then(async () => {
      const db = await this.ready();
      if (idempotencyKey && db.idempotency[idempotencyKey]) {
        return { replay: true, ...db.idempotency[idempotencyKey] };
      }
      if (expectedVersion != null && Number(expectedVersion) !== db.version) {
        throw new HttpError(409, "version_conflict", {
          currentVersion: db.version, expectedVersion: Number(expectedVersion),
        });
      }
      // mutator 在 db 上原地修改，返回值会作为 API 响应
      let result;
      try {
        result = await mutator(db);
      } catch (err) {
        // 业务校验失败：丢弃可能已被部分弄脏的内存副本，回到上一已提交版本
        await this.reloadFromDisk();
        throw err;
      }
      db.version += 1;
      if (idempotencyKey) {
        db.idempotency[idempotencyKey] = {
          status: result?.status ?? 200,
          body: result?.body ?? null,
          version: db.version,
        };
        // 幂等表裁剪到最近 200 条，随业务数据同一次原子写落盘
        const keys = Object.keys(db.idempotency);
        if (keys.length > 200) {
          for (const old of keys.slice(0, keys.length - 200)) delete db.idempotency[old];
        }
      }
      try {
        await this.persist(db);
      } catch (err) {
        // 落盘失败：本次对内存副本的损伤/寿命/冻结修改整体丢弃，回到上一已提交版本
        await this.reloadFromDisk();
        throw err;
      }
      return { replay: false, status: result?.status ?? 200, body: result?.body ?? null, version: db.version };
    });
    // 队列必须始终推进，拒绝不能卡住后续请求
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async persist(db) {
    const tmp = `${this.file}.tmp-${randomBytes(4).toString("hex")}`;
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("injected_write_failure");
    }
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, this.file);
  }

  // 写入失败后的恢复：丢弃被弄脏的内存副本，从磁盘读回上一个已提交版本
  async reloadFromDisk() {
    this.db = JSON.parse(await readFile(this.file, "utf8"));
    return this.db;
  }

  // 供“重启持久化”测试：清空内存状态，下次访问重新从磁盘加载
  async simulateRestart() {
    this.db = null;
    await this.ready();
  }
}
