// 令牌使用闸门
//
// 刷新会重写 token.json，而正在使用令牌的请求已经带着旧令牌建了连；反过来，
// 刷新窗口里若照旧取令牌，新请求拿到的会是一份正在被替换、随时失效的文件。
// 所以「替换令牌」和「使用令牌」必须互斥，规则只有两条：
//
//   1. 还有请求在用令牌（inFlight > 0）→ 不刷新，让它们跑完；
//   2. 正在刷新 → 新请求等刷新落地，再进入。
//
// 触发点有两个：请求进入时发现令牌陈旧（此刻空闲就当场换），以及最后一个请求
// 离开时（趁没人用把陈旧的换掉，下一个请求就不必等）。刷新失败后短时间内不再重试。
//
// 零依赖，仅用 Node 标准库。

/**
 * 创建一个令牌使用闸门。
 *
 * `trigger` 只是「让刷新进程跑起来」，它 resolve 不代表令牌已更新 —— 新令牌要等
 * 刷新脚本收割完才落盘，所以这里轮询 `readStamp()` 直到它比触发前更大，才放请求
 * 进去。等不到就放弃等待，让请求带着现有令牌继续：刷新失败不该把请求一起拖死。
 * @param {object} options 闸门所需的读者与动作。
 * @param {() => number} options.readStamp 读当前令牌的收割时间戳（秒）；没有令牌时返回 0。
 * @param {number} options.staleSec 令牌年龄超过它就算需要更换。
 * @param {number} options.waitMs 触发之后，等新令牌落盘的上限。
 * @param {() => Promise<{started: boolean, refusal?: string|null}>} options.trigger 触发一次刷新。
 * @param {(message: string) => void} [options.log] 收过程日志。
 * @param {number} [options.pollMs] 等新令牌时的轮询间隔。
 * @param {number} [options.retryMs] 一次刷新失败后，多久之内不再重试。
 * @returns {{enter: () => Promise<void>, leave: () => void, state: () => {inFlight: number, refreshing: boolean}, dispose: () => void}}
 *   `enter` 占用一个使用名额并保证令牌已尝试换新，`leave` 归还名额，`dispose` 停掉等待。
 */
export function createTokenGate(options) {
  const {
    readStamp, staleSec, waitMs, trigger, log = () => {}, pollMs = 1000, retryMs = 60000,
  } = options;

  /** 正在使用令牌的请求数；它归零前不开始刷新。 */
  let inFlight = 0;
  /** 进行中的刷新；非 null 时新请求等它落地。 */
  let refreshing = null;
  /** 上一次刷新失败的时刻，0 表示没有失败过。 */
  let failedAt = 0;
  /** 反代停了以后不再开始新刷新，也不再为等待中的刷新留定时器。 */
  let disposed = false;

  /**
   * 令牌是否已过陈旧阈值。没有令牌时不算陈旧：那时刷新脚本自己也未必收割成功，
   * 反复触发只会白白改系统代理。读不到就当作不陈旧 —— 这里抛出会直接落到 `enter()`
   * 的调用方，把一个可用的请求弄失败。
   */
  const stale = () => {
    try {
      const stamp = readStamp();
      return stamp > 0 && Date.now() / 1000 - stamp > staleSec;
    } catch (error) {
      log(`[闸门] 读令牌失败：${error?.message || error}`);
      return false;
    }
  };

  /**
   * 触发一次刷新，并等新令牌落盘。
   *
   * 每一步都收在一个 try 里：读令牌、触发、轮询都可能抛，而这个函数的返回值会被
   * 在途请求 await —— 它抛出就等于把请求一起弄失败，那比放行一个陈旧令牌更糟。
   * @returns 新令牌是否已生效。
   */
  async function replace() {
    try {
      const before = readStamp();
      const outcome = await trigger();
      if (!outcome?.started) {
        log(`[闸门] 刷新未启动（${outcome?.refusal || 'unknown'}）—— 继续用现有令牌`);
        return false;
      }
      log('[闸门] 已触发刷新，等新令牌落盘...');
      const deadline = Date.now() + waitMs;
      while (!disposed && Date.now() < deadline) {
        await new Promise((resolve) => { setTimeout(resolve, pollMs); });
        if (readStamp() > before) {
          log('[闸门] 新令牌已生效');
          return true;
        }
      }
      log(disposed
        ? '[闸门] 反代已停止，不再等这一次刷新'
        : `[闸门] 等新令牌超时（${Math.round(waitMs / 1000)} 秒）—— 继续用现有令牌`);
      return false;
    } catch (error) {
      log(`[闸门] 刷新过程异常：${error?.message || error}`);
      return false;
    }
  }

  /**
   * 空闲且令牌陈旧时开始刷新。
   *
   * 已经有人在用、或已有刷新在跑时都不动手：前者是「不打断在途请求」，后者是
   * 「一次只换一份」。刚刚失败过也不动手 —— 失败原因（Copilot 没开、前置条件不齐）
   * 不会在几秒内自己消失，每个请求都去撞一次只是白跑检测、白刷日志。
   * @returns 进行中的刷新，没有则 null。
   */
  function startIfIdle() {
    if (disposed || refreshing || inFlight > 0 || !stale()) return refreshing;
    if (Date.now() - failedAt < retryMs) return null;
    refreshing = replace()
      .then((replaced) => { failedAt = replaced ? 0 : Date.now(); })
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  return {
    async enter() {
      if (refreshing) {
        await refreshing;
      } else if (inFlight === 0) {
        const pending = startIfIdle();
        if (pending) await pending;
      }
      // 占位与上面的判断之间不能有 await：否则两个并发请求会同时读到 inFlight === 0，
      // 各自触发一次刷新，也可能把一个请求放行在刷新窗口里。
      inFlight++;
    },
    leave() {
      if (inFlight > 0) inFlight--;
      // 最后一个请求走了：此刻令牌若已陈旧，趁没人用换掉，下一个请求就不必等。
      void startIfIdle();
    },
    state: () => ({ inFlight, refreshing: Boolean(refreshing) }),
    dispose() {
      // 只是让等待中的刷新提前收尾：定时器是它唯一的落脚点，清掉它就不必为一个
      // 已经停掉的反代把进程多留两分钟。
      disposed = true;
    },
  };
}
