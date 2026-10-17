// 对外入口。分三层，用哪个层取决于你要多少控制权：
//   protocol —— 只是形状和规则，不碰磁盘
//   store    —— 文件原语（原子写、抢锁、游标）
//   *        —— 面向「参与者」的操作

export * from './protocol.mjs';
export * from './store.mjs';
export * from './participant.mjs';
export * from './send.mjs';
