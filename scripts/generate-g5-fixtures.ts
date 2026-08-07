import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { canonicalJson, canonicalJsonl, renderCard } from '../src/course/io.ts';
import { STARRYOS_SHARED_NODES, STARRYOS_SHARED_SOURCES } from '../src/course/shared.ts';
import type {
  CourseCard,
  CourseGate,
  CoursePractice,
  CourseQuestion,
  CourseStage,
  CourseUnit,
} from '../src/course/types.ts';
import type { PtkgEdge, PtkgNode, PtkgSource } from '../src/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const GENERATOR = { tool: '@os-camp/ptkg', version: '0.4.0', agent: 'g5-golden-course' } as const;
const STARRY_REPO = 'https://github.com/rcore-os/tgoskits';
const STARRY_COMMIT = 'fc80b868fb3640efe8997994de42c1aee8fd74cb';
const STARRY_TREE = '832ce21ea6fdf32a8639c576cc97a137c2d14dcc';
const RCORE_REPO = 'https://github.com/rcore-os/rCore-Tutorial-v3.git';
const RCORE_COMMIT = 'c91bd3752b53ff48555aef4e3c7b8d5ddc8ee6e1';
const RCORE_TREE = 'f649d5b69c790b85ea323edc5c9d02afbbb66104';

interface AbiUnitSpec {
  slug: string;
  title: string;
  stage: 'tutorial' | 'foundation' | 'pre_project';
  depth: number;
  path: string;
  blob: string;
  focus: string;
  kind: CoursePractice['kind'];
  node: string;
  shared: string[];
  prerequisites: string[];
}

const ABI_UNITS: AbiUnitSpec[] = [
  {
    slug: 'build-qemu', title: '固定源码、构建矩阵与 QEMU 基线', stage: 'tutorial', depth: 0,
    path: 'xtask/src/main.rs', blob: '7a02fd7a65a77f3b89abd259259d4b39ce14405a',
    focus: '锁定 commit/tree、Rust 工具链、架构、rootfs 与 QEMU 参数，并保存失败也完整的构建证据',
    kind: 'test', node: 'outcome.starryos.abi.validation', shared: ['kc.os.build.reproducible-qemu', 'kc.os.testing.four-way-evidence'], prerequisites: [],
  },
  {
    slug: 'rust-no-std', title: 'Rust no_std 与内核能力边界', stage: 'tutorial', depth: 1,
    path: 'Cargo.toml', blob: '50e26804db3869ed5ec7ae4007b327e83fa6edb7',
    focus: '区分 core/alloc、宿主 std、平台 crate 与初始化顺序，避免把宿主示例直接复制进内核',
    kind: 'trace', node: 'outcome.starryos.abi.contracts', shared: ['kc.rust.no-std.kernel-boundaries'], prerequisites: ['build-qemu'],
  },
  {
    slug: 'abi-contract', title: 'Linux ABI 合同、errno 与跨架构数据布局', stage: 'foundation', depth: 2,
    path: 'os/StarryOS/kernel/src/syscall/mod.rs', blob: '9db1f94fb40f55818122f7864638f4bfd6a0f42e',
    focus: '把 syscall number、参数宽度、结构体布局、flags、返回值和 Linux errno 作为一个不可拆散的外部合同核实',
    kind: 'trace', node: 'outcome.starryos.abi.contracts', shared: [], prerequisites: ['rust-no-std'],
  },
  {
    slug: 'user-memory', title: '用户指针、地址空间与 copy 边界', stage: 'foundation', depth: 3,
    path: 'os/StarryOS/kernel/src/mm/access.rs', blob: 'cfc7bd12751924875332d0cfe524fdab44a84f13',
    focus: '核实用户地址、长度、跨页访问、权限、字符串终止和失败时 EFAULT 路径，禁止直接解引用用户指针',
    kind: 'code', node: 'outcome.starryos.abi.contracts', shared: ['kc.rust.no-std.kernel-boundaries'], prerequisites: ['abi-contract'],
  },
  {
    slug: 'dispatch-arch', title: 'syscall 分发与多架构编号差异', stage: 'foundation', depth: 3,
    path: 'os/StarryOS/kernel/src/syscall/mod.rs', blob: '9db1f94fb40f55818122f7864638f4bfd6a0f42e',
    focus: '从 trap 上下文参数提取追踪到 Sysno 分支、架构 cfg、错误映射和返回寄存器，识别 ENOSYS 与伪成功的差别',
    kind: 'trace', node: 'outcome.starryos.abi.contracts', shared: [], prerequisites: ['abi-contract'],
  },
  {
    slug: 'process-lifecycle', title: 'clone/exec/exit/wait 进程生命周期', stage: 'foundation', depth: 4,
    path: 'os/StarryOS/kernel/src/syscall/task/clone.rs', blob: '5cbf93c8ea6e4fedd298134a3336b3d65404c68c',
    focus: '贯通 clone flags、资源共享、exec 地址空间替换、exit 通知、wait 回收和失败回滚，而不是只实现一个创建入口',
    kind: 'debug', node: 'outcome.starryos.abi.subsystems', shared: ['kc.os.process.lifecycle', 'kc.os.concurrency.lock-and-lifetime'], prerequisites: ['dispatch-arch', 'user-memory'],
  },
  {
    slug: 'vfs-fd-path', title: 'VFS、文件描述符、路径与 stat 语义', stage: 'foundation', depth: 4,
    path: 'os/StarryOS/kernel/src/syscall/fs/fd_ops.rs', blob: '97a422d496e8259061598fbea7dcc1439405b971',
    focus: '核实 fd 表生命周期、路径解析、open flags、目录和符号链接边界、stat 布局以及错误优先级',
    kind: 'code', node: 'outcome.starryos.abi.subsystems', shared: ['kc.os.vfs.axfs-ng-vfs-traits', 'kc.os.concurrency.lock-and-lifetime'], prerequisites: ['user-memory'],
  },
  {
    slug: 'virtual-memory', title: 'brk/mmap/mprotect 与地址空间不变量', stage: 'foundation', depth: 4,
    path: 'os/StarryOS/kernel/src/syscall/mm/mmap.rs', blob: 'fc48d47101454aa58362f5927aa623db0dceb33f',
    focus: '核实地址对齐、匿名/文件映射、权限、重叠、回收和失败原子性，并用负例区分参数接受与真实映射生效',
    kind: 'code', node: 'outcome.starryos.abi.subsystems', shared: ['kc.os.concurrency.lock-and-lifetime'], prerequisites: ['user-memory'],
  },
  {
    slug: 'signals', title: '信号投递、mask、handler 与 sigreturn', stage: 'pre_project', depth: 5,
    path: 'os/StarryOS/kernel/src/syscall/signal.rs', blob: 'ff259fdb062de2a1bb143be54bb82c786b2450ba',
    focus: '贯通信号产生、线程/进程选择、pending/mask、用户栈 frame、handler 和 sigreturn 上下文恢复',
    kind: 'debug', node: 'outcome.starryos.abi.subsystems', shared: ['kc.os.process.lifecycle', 'kc.os.concurrency.lock-and-lifetime'], prerequisites: ['process-lifecycle', 'user-memory'],
  },
  {
    slug: 'futex-sync', title: 'futex、唤醒竞态与同步合同', stage: 'pre_project', depth: 5,
    path: 'os/StarryOS/kernel/src/syscall/sync/futex.rs', blob: '320d8293d5eb1476419dd653a9c6d34f69620cc6',
    focus: '核实值比较、等待队列键、超时、唤醒数量、spurious wakeup 和退出清理，并重放已知 wait/wake 回归',
    kind: 'debug', node: 'outcome.starryos.abi.subsystems', shared: ['kc.os.process.lifecycle', 'kc.os.concurrency.lock-and-lifetime', 'kc.os.testing.four-way-evidence'], prerequisites: ['process-lifecycle'],
  },
  {
    slug: 'ipc', title: 'System V IPC 与共享内存生命周期', stage: 'pre_project', depth: 5,
    path: 'os/StarryOS/kernel/src/syscall/ipc/mod.rs', blob: '600adf37493bc7bc3397d03895c2efc2939870f5',
    focus: '核实对象标识、权限、消息复制、共享内存 attach/detach、删除时机和并发引用生命周期',
    kind: 'review', node: 'outcome.starryos.abi.subsystems', shared: ['kc.os.process.lifecycle', 'kc.os.concurrency.lock-and-lifetime'], prerequisites: ['process-lifecycle', 'user-memory'],
  },
  {
    slug: 'time-timers', title: '时钟、睡眠与 timer 系列语义', stage: 'pre_project', depth: 5,
    path: 'os/StarryOS/kernel/src/syscall/time.rs', blob: '3c59a8cb1732c76612c8fe0c972751856f5e9c8f',
    focus: '区分单调/实时时钟、相对/绝对超时、精度、剩余时间、信号中断和定时器资源回收',
    kind: 'test', node: 'outcome.starryos.abi.subsystems', shared: ['kc.os.testing.four-way-evidence'], prerequisites: ['dispatch-arch'],
  },
  {
    slug: 'network-sockets', title: 'socket 地址、状态机与消息边界', stage: 'pre_project', depth: 5,
    path: 'os/StarryOS/kernel/src/syscall/net/socket.rs', blob: 'd1984829749e6128a21fd9e8678b09611c5d7861',
    focus: '核实地址族、sockaddr 长度、bind/connect/listen/accept 状态转换、阻塞语义、flags 和部分传输',
    kind: 'debug', node: 'outcome.starryos.abi.subsystems', shared: ['kc.os.concurrency.lock-and-lifetime', 'kc.os.testing.four-way-evidence'], prerequisites: ['vfs-fd-path', 'user-memory'],
  },
  {
    slug: 'event-multiplexing', title: 'poll/select/epoll 事件多路复用', stage: 'pre_project', depth: 6,
    path: 'os/StarryOS/kernel/src/syscall/io_mpx/epoll.rs', blob: '60477b0e905f814ee40502e1acef771f29924a14',
    focus: '核实 readiness、边沿/水平触发、oneshot、fd 关闭、超时和信号交互，避免把一次可读事件当成完整 epoll 语义',
    kind: 'test', node: 'outcome.starryos.abi.subsystems', shared: ['kc.os.concurrency.lock-and-lifetime', 'kc.os.testing.four-way-evidence'], prerequisites: ['vfs-fd-path', 'signals'],
  },
  {
    slug: 'resources-security', title: '凭据、rlimit、namespace 与安全边界', stage: 'pre_project', depth: 6,
    path: 'os/StarryOS/kernel/src/syscall/resources.rs', blob: '719146a88eebb1a134aa3b7dbebaea203749730e',
    focus: '核实 uid/gid/capability、rlimit、prctl、namespace 和资源查询的权限、继承及跨架构兼容边界',
    kind: 'review', node: 'outcome.starryos.abi.contracts', shared: ['kc.os.process.lifecycle', 'kc.os.testing.four-way-evidence'], prerequisites: ['process-lifecycle', 'abi-contract'],
  },
  {
    slug: 'compat-regression', title: '兼容矩阵、seeded fault 与回归证据', stage: 'pre_project', depth: 7,
    path: 'test-suit/starryos/qemu-smp1/system/syscall-test-compat/src/main.c', blob: 'e235aef46d9e65dce7bae49b51aa3044318dfcf1',
    focus: '从应用行为建立 syscall/架构/错误路径矩阵，先证明测试能识别 seeded fault，再把通过、失败和未运行分开报告',
    kind: 'test', node: 'outcome.starryos.abi.validation', shared: ['kc.os.build.reproducible-qemu', 'kc.os.testing.four-way-evidence'], prerequisites: ['signals', 'futex-sync', 'ipc', 'time-timers', 'network-sockets', 'event-multiplexing', 'resources-security', 'virtual-memory'],
  },
];

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content.replaceAll('\r\n', '\n'), 'utf8');
}

function yaml(value: unknown): string {
  return YAML.stringify(value, { lineWidth: 0 });
}

function source(id: string, title: string, file: string, blob: string): PtkgSource {
  return {
    id,
    type: 'source',
    source_kind: 'repo_file',
    title,
    url: `${STARRY_REPO}/blob/${STARRY_COMMIT}/${file}`,
    retrieved_at: '2026-08-07',
    version_or_ref: STARRY_COMMIT,
    trust_level: 'A',
    supports: [`固定源码对象 ${file}`],
    blob_oid: blob,
  };
}

function abiSourceId(slug: string): string {
  return `src.starryos.abi.${slug}`;
}

function abiProjectNodes(): PtkgNode[] {
  const repoArtifact = (file: string, role: string) => ({ repo: STARRY_REPO, ref: STARRY_COMMIT, path: file, role });
  const project: PtkgNode = {
    id: 'project.starryos.linux-abi', type: 'project', title: '完善 StarryOS Linux ABI 与 syscall 兼容工程', status: 'candidate',
    mission: '以完整 Linux 应用兼容工程为倒推根，建立学生进入项目阶段前所需的 ABI 合同、跨子系统源码、受控实现和验证能力。',
    repository: { url: STARRY_REPO, ref: STARRY_COMMIT },
    target_environment: { arch: 'riscv64 / aarch64 / x86_64 / loongarch64', toolchain: 'Rust nightly, no_std', runner: 'QEMU' },
    curriculum_scope: {
      mode: 'pre_project_readiness', entry: '具备 Rust、C、Git 和基础 OS 知识', exit: 'Project Readiness Gate：能够按 Linux ABI 合同定位、修改和验证跨子系统行为',
      readiness_criteria: ['能固定并复现 StarryOS 多架构构建与 QEMU 环境', '能从 syscall 分发追踪到任务、内存、VFS、信号、同步、网络等子系统', '能把参数、数据布局、错误码、状态变化和资源回收写成可测试行为合同', '能在隔离分支完成受控修改并提交正例、负例、并发与回归证据'],
      excluded_responsibilities: ['真实项目分工与个人贡献评价', '要求提交或合并上游 PR'],
    },
    outcomes: ['完整覆盖 Linux ABI/syscall 工程的共享主干和主要子系统', '每个必修域均绑定固定源码与高保真实践', '学生止于项目准备度门'],
    acceptance: { functional: ['能追踪完整 syscall 行为链'], compatibility: ['能解释跨架构 ABI 差异'], concurrency: ['能验证竞争和资源回收'], quality: ['证据可重放并绑定固定源码'] },
    non_goals: ['不以一个 syscall 代替完整兼容工程', '不分配真实上游任务', '不把未执行测试写成通过'],
    source_ids: ['src.tgoskits.fc80b868', 'src.starryos.abi.dispatch-arch', 'src.starryos.abi.compat-regression'],
  };
  return [
    project,
    { id: 'outcome.starryos.abi.contracts', type: 'outcome', title: '稳定的 Linux ABI 外部合同', status: 'candidate', project_value: '让 Linux 应用看到一致的编号、参数、布局、返回值和 errno。', system_boundary: '从 trap 上下文进入 syscall 分发，到用户内存和各子系统入口。', source_ids: ['src.starryos.abi.dispatch-arch'] },
    { id: 'outcome.starryos.abi.subsystems', type: 'outcome', title: '跨子系统 syscall 行为闭环', status: 'candidate', project_value: '让进程、VFS、内存、信号、同步、IPC、时间和网络行为形成完整生命周期。', system_boundary: 'syscall 层只做 ABI 适配，状态和资源语义由目标子系统实现。', source_ids: ['src.starryos.abi.process-lifecycle', 'src.starryos.abi.vfs-fd-path'] },
    { id: 'outcome.starryos.abi.validation', type: 'outcome', title: '多架构兼容和回归证据', status: 'candidate', project_value: '用应用行为与错误路径矩阵防止伪实现和回归。', system_boundary: '固定 QEMU、测试镜像和无网络隔离环境。', source_ids: ['src.starryos.abi.compat-regression'] },
    { id: 'wp.starryos.abi.contract-audit', type: 'work_package', title: 'ABI 合同与分发审计', status: 'candidate', parent_outcome_id: 'outcome.starryos.abi.contracts', deliverables: ['syscall 合同表', '跨架构差异表', '用户内存边界清单'], definition_of_done: ['编号、参数、布局、errno 和 unsupported 行为均有来源与测试'], source_ids: ['src.starryos.abi.dispatch-arch'] },
    { id: 'wp.starryos.abi.subsystem-chains', type: 'work_package', title: '跨子系统行为链核实', status: 'candidate', parent_outcome_id: 'outcome.starryos.abi.subsystems', deliverables: ['进程/VFS/MM/信号/同步/IPC/时间/网络行为链'], definition_of_done: ['每条链覆盖正常、失败、并发和资源回收'], source_ids: ['src.starryos.abi.process-lifecycle', 'src.starryos.abi.futex-sync'] },
    { id: 'wp.starryos.abi.compat-matrix', type: 'work_package', title: '兼容矩阵与 seeded fault', status: 'candidate', parent_outcome_id: 'outcome.starryos.abi.validation', deliverables: ['多架构测试矩阵', 'seeded fault 判别记录', '回归报告'], definition_of_done: ['测试能识别故意绕过的错误路径，未执行项保持 unresolved'], source_ids: ['src.starryos.abi.compat-regression'] },
    { id: 'competency.starryos.abi.contract', type: 'competency', title: '建立可验证的 syscall ABI 合同', status: 'candidate', claim: '在固定 commit 和目标架构下，学生能够从分发代码与 Linux 接口语义建立 syscall 编号、参数、布局、返回值和 errno 合同，并用负例证明错误路径。', quality_criteria: ['所有结论绑定固定源码', '不把 dummy success 当兼容', '包含至少一个非法指针或非法 flag 负例'], source_ids: ['src.starryos.abi.dispatch-arch'] },
    { id: 'competency.starryos.abi.lifecycle', type: 'competency', title: '追踪跨子系统状态与资源生命周期', status: 'candidate', claim: '在进程、文件、内存和并发状态交织时，学生能够追踪 syscall 引发的状态变化与资源获取释放，并用失败注入和并发测试证明不泄漏。', quality_criteria: ['标出锁与所有权', '覆盖失败回滚和退出清理', '证据包含代码 trace 与运行结果'], source_ids: ['src.starryos.abi.process-lifecycle', 'src.starryos.abi.futex-sync'] },
    { id: 'competency.starryos.abi.validation', type: 'competency', title: '构建兼容与回归证据矩阵', status: 'candidate', claim: '在固定 QEMU 和多架构矩阵下，学生能够设计正例、负例、并发、回归与 seeded fault 测试，并诚实区分通过、失败和未运行。', quality_criteria: ['命令和环境可重放', 'seeded fault 必须被识别', '失败也保存 stdout/stderr 与退出码'], source_ids: ['src.starryos.abi.compat-regression'] },
    { id: 'practice.starryos.abi.trace-contract', type: 'practice', title: '追踪 syscall ABI 合同', status: 'candidate', task_level: 'T1', scenario: '从 syscall 分发选取跨架构入口，核实编号、参数、用户内存、错误映射和返回寄存器。', deliverables: ['ABI 合同表', '调用链', '负例设计'], tests: { positive: ['合法调用返回目标结果'], negative: ['非法指针或 flags 返回正确 errno'] }, uses_repo_artifacts: [repoArtifact('os/StarryOS/kernel/src/syscall/mod.rs', 'syscall 分发')], source_ids: ['src.starryos.abi.dispatch-arch'] },
    { id: 'practice.starryos.abi.trace-lifecycle', type: 'practice', title: '追踪跨子系统生命周期', status: 'candidate', task_level: 'T2', scenario: '在隔离教学分支追踪并观测进程、VFS 或 futex 的状态、锁和清理路径。', deliverables: ['状态转换图', '锁与所有权表', '失败/并发证据'], tests: { positive: ['正常生命周期完成'], negative: ['失败路径回滚'], concurrency: ['竞争条件不泄漏或死锁'], regression: ['既有行为保持'] }, uses_repo_artifacts: [repoArtifact('os/StarryOS/kernel/src/syscall/task/clone.rs', '进程生命周期入口')], safety: ['只修改可丢弃教学分支'], source_ids: ['src.starryos.abi.process-lifecycle'] },
    { id: 'practice.starryos.abi.compat-matrix', type: 'practice', title: '运行兼容矩阵与 seeded fault', status: 'candidate', task_level: 'T2', scenario: '固定环境运行兼容用例，并注入一个会绕过校验的 fault 检验测试判别力。', deliverables: ['环境清单', '测试矩阵', 'fault 判别和复盘'], tests: { positive: ['基线行为记录'], negative: ['非法输入被拒绝'], concurrency: ['并发用例有边界'], regression: ['seeded fault 被识别'] }, uses_repo_artifacts: [repoArtifact('test-suit/starryos/qemu-smp1/system/syscall-test-compat/src/main.c', '兼容测试入口')], safety: ['QEMU 禁网、限时、无 secret'], source_ids: ['src.starryos.abi.compat-regression'] },
    { id: 'kc.os.abi.linux-syscall-contract', type: 'knowledge', scope: 'canonical', title: 'Linux syscall ABI 合同', status: 'candidate', statement: '学生能够把 syscall 编号、调用约定、参数和结构体布局、返回值、errno 与 unsupported 行为写成可测试合同。', misconceptions: ['只要函数存在就认为 syscall 兼容', '用返回 0 的 dummy 实现掩盖 unsupported'], diagnostic: '给出一个总返回 0 的空实现，判断它破坏了哪些 ABI 合同。', remediation: ['对照调用方行为补全布局、错误码和状态变化。'], source_ids: ['src.starryos.abi.dispatch-arch'] },
    ...STARRYOS_SHARED_NODES,
    { id: 'binding.starryos.abi.dispatch@fc80b86', type: 'project_binding', title: 'Linux syscall ABI 在 StarryOS 分发器上的绑定', status: 'candidate', canonical_node_id: 'kc.os.abi.linux-syscall-contract', project_id: 'project.starryos.linux-abi', project_semantics: 'StarryOS 使用 Rust syscalls crate 的 Sysno 并按四种 64 位架构 cfg 分发；未知入口映射为 Unsupported/ENOSYS。', repo_artifacts: [repoArtifact('os/StarryOS/kernel/src/syscall/mod.rs', '固定分发实现')], used_by_work_packages: ['wp.starryos.abi.contract-audit'], practice_ids: ['practice.starryos.abi.trace-contract'], differences_from_canonical: ['部分 Linux 入口明确 unsupported，不能用 dummy success 代替'], reuse_relation: 'SPECIALIZES', source_ids: ['src.starryos.abi.dispatch-arch'] },
    { id: 'evidence.starryos.abi.contract-table', type: 'evidence', title: 'ABI 合同与负例报告', status: 'candidate', evidence_kind: 'code_trace', artifacts: ['合同表', '调用链', '负例结果'], collection: 'server_or_teacher_verified', mastery_weight: 'medium', source_ids: ['src.starryos.abi.dispatch-arch'] },
    { id: 'evidence.starryos.abi.lifecycle-report', type: 'evidence', title: '生命周期受控实验报告', status: 'candidate', evidence_kind: 'controlled_change', artifacts: ['隔离 diff', '状态/锁表', '失败与并发结果'], collection: 'server_or_teacher_verified', mastery_weight: 'high', source_ids: ['src.starryos.abi.process-lifecycle'] },
    { id: 'evidence.starryos.abi.compat-report', type: 'evidence', title: '兼容矩阵与 fault 判别报告', status: 'candidate', evidence_kind: 'test_report', artifacts: ['环境 digest', '测试矩阵', 'seeded fault 结果'], collection: 'server_or_teacher_verified', mastery_weight: 'high', source_ids: ['src.starryos.abi.compat-regression'] },
  ];
}

function abiProjectEdges(): PtkgEdge[] {
  const edge = (id: number, from: string, type: PtkgEdge['type'], to: string, extra: Partial<PtkgEdge> = {}): PtkgEdge => ({ id: `edge.abi.${String(id).padStart(3, '0')}`, from, type, to, status: 'candidate', ...extra });
  const edges: PtkgEdge[] = [
    edge(1, 'project.starryos.linux-abi', 'DECOMPOSES_TO', 'outcome.starryos.abi.contracts'),
    edge(2, 'project.starryos.linux-abi', 'DECOMPOSES_TO', 'outcome.starryos.abi.subsystems'),
    edge(3, 'project.starryos.linux-abi', 'DECOMPOSES_TO', 'outcome.starryos.abi.validation'),
    edge(4, 'outcome.starryos.abi.contracts', 'DECOMPOSES_TO', 'wp.starryos.abi.contract-audit'),
    edge(5, 'outcome.starryos.abi.subsystems', 'DECOMPOSES_TO', 'wp.starryos.abi.subsystem-chains'),
    edge(6, 'outcome.starryos.abi.validation', 'DECOMPOSES_TO', 'wp.starryos.abi.compat-matrix'),
    edge(7, 'wp.starryos.abi.contract-audit', 'REQUIRES', 'competency.starryos.abi.contract', { requirement_kind: 'required' }),
    edge(8, 'wp.starryos.abi.subsystem-chains', 'REQUIRES', 'competency.starryos.abi.lifecycle', { requirement_kind: 'required' }),
    edge(9, 'wp.starryos.abi.compat-matrix', 'REQUIRES', 'competency.starryos.abi.validation', { requirement_kind: 'required' }),
    edge(10, 'competency.starryos.abi.contract', 'PROVEN_BY', 'evidence.starryos.abi.contract-table'),
    edge(11, 'competency.starryos.abi.lifecycle', 'PROVEN_BY', 'evidence.starryos.abi.lifecycle-report'),
    edge(12, 'competency.starryos.abi.validation', 'PROVEN_BY', 'evidence.starryos.abi.compat-report'),
    edge(13, 'evidence.starryos.abi.contract-table', 'ELICITED_BY', 'practice.starryos.abi.trace-contract'),
    edge(14, 'evidence.starryos.abi.lifecycle-report', 'ELICITED_BY', 'practice.starryos.abi.trace-lifecycle'),
    edge(15, 'evidence.starryos.abi.compat-report', 'ELICITED_BY', 'practice.starryos.abi.compat-matrix'),
    edge(16, 'practice.starryos.abi.trace-contract', 'REQUIRES', 'kc.os.abi.linux-syscall-contract', { requirement_kind: 'required' }),
    edge(17, 'binding.starryos.abi.dispatch@fc80b86', 'BINDS', 'kc.os.abi.linux-syscall-contract'),
  ];
  let index = 18;
  for (const node of STARRYOS_SHARED_NODES) {
    const practice = node.id === 'kc.os.build.reproducible-qemu' || node.id === 'kc.os.testing.four-way-evidence'
      ? 'practice.starryos.abi.compat-matrix'
      : node.id === 'kc.os.process.lifecycle' || node.id === 'kc.os.concurrency.lock-and-lifetime'
        ? 'practice.starryos.abi.trace-lifecycle'
        : 'practice.starryos.abi.trace-contract';
    edges.push(edge(index++, practice, 'REQUIRES', node.id, { requirement_kind: 'required' }));
  }
  return edges;
}

function abiCourseAssets(): { stages: CourseStage[]; units: CourseUnit[]; questions: CourseQuestion[]; practices: CoursePractice[]; gates: CourseGate[]; cards: Array<Omit<CourseCard, 'file'>> } {
  const unitId = (slug: string) => `unit.starryos.abi.${slug}`;
  const gateId = (slug: string) => `gate.starryos.abi.${slug}`;
  const stageId = (layer: AbiUnitSpec['stage']) => `stage.starryos.abi.${layer.replace('_', '-')}`;
  const units: CourseUnit[] = [];
  const questions: CourseQuestion[] = [];
  const practices: CoursePractice[] = [];
  const gates: CourseGate[] = [];
  const cards: Array<Omit<CourseCard, 'file'>> = [];
  for (const spec of ABI_UNITS) {
    const id = unitId(spec.slug);
    const sourceId = abiSourceId(spec.slug);
    const nodeIds = [...new Set(['project.starryos.linux-abi', spec.node, ...spec.shared])];
    const questionIds = ['diagnostic.1', 'diagnostic.2', 'checkpoint.1', 'checkpoint.2'].map((suffix) => `question.starryos.abi.${spec.slug}.${suffix}`);
    const practiceId = `course-practice.starryos.abi.${spec.slug}`;
    const unitGate = gateId(spec.slug);
    units.push({
      id, stage_id: stageId(spec.stage), title: spec.title, required: true, node_ids: nodeIds,
      prerequisite_unit_ids: spec.prerequisites.map(unitId), source_refs: ['src.tgoskits.fc80b868', sourceId],
      origin_projects: ['project.starryos.linux-abi'], reuse_count: spec.shared.length > 0 ? 2 : 1, dependency_depth: spec.depth,
      card_ids: [`card.starryos.abi.${spec.slug}`], question_ids: questionIds, practice_ids: [practiceId], gate_ids: [unitGate],
      status: 'candidate', generated_by: GENERATOR, content_hash: '',
    });
    const questionBase = { unit_ids: [id], node_ids: nodeIds, source_refs: [sourceId], status: 'candidate' as const, generated_by: GENERATOR, content_hash: '' };
    questions.push(
      { ...questionBase, id: questionIds[0] as string, pool: 'diagnostic', type: 'choice', prompt: `${spec.title} 的固定源码入口是哪一个？`, options: [spec.path, '当前默认分支的任意同名文件', 'LLM 根据名称推测的入口'], answer: spec.path, explanation: `课程事实绑定 ${STARRY_COMMIT} 的 ${spec.path}，分支或同名文件不能替代固定源码。`, difficulty: 1 },
      { ...questionBase, id: questionIds[1] as string, pool: 'diagnostic', type: 'design', prompt: `为什么“源码文件存在”不能证明“${spec.focus}”已经成立？`, options: [], answer: '文件存在只证明代码对象存在；必须追踪调用、状态变化、错误与资源路径，并以真实执行证据验证行为。', explanation: '名称和静态结构不是行为证据，partial/unresolved 状态必须保留。', difficulty: 2 },
      { ...questionBase, id: questionIds[2] as string, pool: 'checkpoint', type: 'code', prompt: `基于 ${spec.path} 设计一条从入口到目标状态的代码追踪，并列出一个失败路径。`, options: [], answer: `追踪参数/状态/调用/返回，并为 ${spec.focus} 列出错误码、回滚或资源清理路径。`, explanation: 'checkpoint 要求把 ABI、实现和失败语义连成可核查链。', difficulty: 3 },
      { ...questionBase, id: questionIds[3] as string, pool: 'checkpoint', type: 'design', prompt: `为“${spec.focus}”给出正例、负例、并发和回归证据；不适用项必须说明原因。`, options: [], answer: '每类证据写明前置、操作、预期、观测与退出码；未真实运行时状态保持 unresolved。', explanation: '四类证据用于识别 happy-path 假通过和 seeded fault。', difficulty: 4 },
    );
    practices.push({
      id: practiceId, unit_ids: [id], node_ids: nodeIds, source_refs: [sourceId], kind: spec.kind, title: `${spec.title}高保真实践`,
      instructions: [`固定 ${STARRY_COMMIT} 并核对 tree ${STARRY_TREE}。`, `阅读 ${spec.path}，记录 blob ${spec.blob}。`, `重放基线并建立与“${spec.focus}”对应的可观察行为。`, '在可丢弃教学分支添加最小 probe、fixture 修改或测试，不提交上游。', '运行正例、负例、并发和回归检查；不适用项记录理由。', '整理源码链、diff、stdout/stderr、退出码、限制和复盘。'],
      expected_evidence: ['固定源码与环境清单', '代码路径和状态/错误边界', '隔离 diff 或测试', '四类测试报告与复盘'],
      allowed_changes: ['可丢弃教学 worktree 中的最小 probe、fixture 和测试'], safety: ['QEMU 禁网、限时、限进程', '无 secret、禁止 push', '未执行不得写成通过'],
      status: 'candidate', generated_by: GENERATOR, content_hash: '',
    });
    gates.push({
      id: unitGate, stage_id: stageId(spec.stage), unit_ids: [id], prerequisite_gate_ids: spec.prerequisites.map(gateId),
      evidence_kinds: ['fixed-source-trace', 'controlled-practice', 'four-way-test-report'],
      pass_policy: `教师核实学生能够解释并验证“${spec.focus}”；候选设计或未执行日志不授予通过。`, trusted_evidence: true,
      status: 'candidate', generated_by: GENERATOR, content_hash: '',
    });
    cards.push({
      id: `card.starryos.abi.${spec.slug}`, title: spec.title, unit_ids: [id], node_ids: nodeIds, source_refs: [sourceId], status: 'candidate', generated_by: GENERATOR,
      body: `固定源码：\`${spec.path}\`，commit \`${STARRY_COMMIT}\`，blob \`${spec.blob}\`。\n\n本单元的行为边界是：${spec.focus}。文件、函数或分支存在只证明代码对象存在，不等于行为完整、跨架构兼容或测试已经通过。\n\n学生从观察、复现和 trace 开始，在隔离 worktree 做最小修改或测试，再用正例、负例、并发和回归证据说明结论。未执行或锚点不明确的部分保持 \`unresolved\`。`,
      content_hash: '',
    });
  }
  const stages: CourseStage[] = [
    { id: stageId('tutorial'), layer: 'tutorial', order: 0, title: '固定环境与 Rust 内核入口', required: true, unit_ids: ABI_UNITS.filter((item) => item.stage === 'tutorial').map((item) => unitId(item.slug)), prerequisite_stage_ids: [], status: 'candidate', source_refs: ['src.tgoskits.fc80b868'], content_hash: '' },
    { id: stageId('foundation'), layer: 'foundation', order: 10, title: 'ABI 合同与核心子系统基础', required: true, unit_ids: ABI_UNITS.filter((item) => item.stage === 'foundation').map((item) => unitId(item.slug)), prerequisite_stage_ids: [stageId('tutorial')], status: 'candidate', source_refs: ['src.starryos.abi.dispatch-arch'], content_hash: '' },
    { id: stageId('pre_project'), layer: 'pre_project', order: 20, title: '复杂行为链与兼容证据', required: true, unit_ids: ABI_UNITS.filter((item) => item.stage === 'pre_project').map((item) => unitId(item.slug)), prerequisite_stage_ids: [stageId('foundation')], status: 'candidate', source_refs: ['src.starryos.abi.compat-regression'], content_hash: '' },
    { id: 'stage.starryos.abi.project-reference', layer: 'project_reference', order: 30, title: '完整兼容工程上下文与准备度出口', required: false, unit_ids: [], prerequisite_stage_ids: [stageId('pre_project')], status: 'candidate', source_refs: ['src.tgoskits.fc80b868'], content_hash: '' },
  ];
  gates.push({
    id: 'gate.starryos.abi.project-readiness', stage_id: stageId('pre_project'), unit_ids: units.map((item) => item.id), prerequisite_gate_ids: gates.map((item) => item.id),
    evidence_kinds: ['fixed-source-replay', 'abi-contract-map', 'controlled-practice', 'four-way-tests', 'teacher-defense'],
    pass_policy: '教师只确认学生具备进入完整 Linux ABI/syscall 兼容项目所需的源码、实践、验证和风险表达能力；不得据此分配或评价真实项目贡献。', trusted_evidence: true,
    status: 'candidate', generated_by: GENERATOR, content_hash: '',
  });
  return { stages, units, questions, practices, gates, cards };
}

async function generateAbiWorkspace(root: string): Promise<void> {
  const assets = abiCourseAssets();
  const repoSource: PtkgSource = { id: 'src.tgoskits.fc80b868', type: 'source', source_kind: 'repo_commit', title: 'rcore-os/tgoskits fixed StarryOS source', url: `${STARRY_REPO}/tree/${STARRY_COMMIT}`, retrieved_at: '2026-08-07', version_or_ref: STARRY_COMMIT, trust_level: 'A', supports: ['完整 Linux ABI/syscall 课程的固定源码身份'], tree_oid: STARRY_TREE };
  const sources = [repoSource, ...STARRYOS_SHARED_SOURCES, ...ABI_UNITS.map((spec) => source(abiSourceId(spec.slug), spec.title, spec.path, spec.blob))];
  await write(root, 'project-input.yaml', yaml({ spec_version: 'ptkg-project-input@1', workspace_id: 'project.starryos.linux-abi', status: 'candidate', repository: { locator: STARRY_REPO, kind: 'remote', requested_ref: STARRY_COMMIT, commit: STARRY_COMMIT, tree: STARRY_TREE }, goal: '完整 StarryOS Linux ABI 与 syscall 兼容项目阶段之前的学习道路', curriculum_boundary: 'pre_project_readiness', documents: [], unresolved_questions: [] }));
  await write(root, '07-projection/manifest.yaml', yaml({ ptkg_version: '0.1', bundle_id: 'ptkg.starryos.linux-abi.golden', title: 'StarryOS Linux ABI/syscall 项目先导图谱', status: 'draft', language: 'zh-CN', created_at: '2026-08-07T00:00:00+08:00', curriculum_version: '0.1.0', project_ref: { repository_url: STARRY_REPO, git_ref: STARRY_COMMIT }, generator: { tool: '@os-camp/ptkg', authoring_kit_version: '0.4.0' }, approval: { status: 'draft', approved_by: null }, files: { nodes: 'nodes.jsonl', edges: 'edges.jsonl', sources: 'sources.jsonl' } }));
  await write(root, '07-projection/nodes.jsonl', canonicalJsonl(abiProjectNodes()));
  await write(root, '07-projection/edges.jsonl', canonicalJsonl(abiProjectEdges()));
  await write(root, '07-projection/sources.jsonl', canonicalJsonl(sources));
  await write(root, '08-governance/review-events.jsonl', '');
  await write(root, '09-course/blueprint.yaml', yaml({ spec_version: 'course-blueprint@1', course_id: 'oscamp.starryos.linux-abi', version: '0.1.0', title: 'StarryOS Linux ABI 与 syscall 项目先导课程', language: 'zh-CN', stages: assets.stages.map(({ content_hash: _hash, ...stage }) => stage) }));
  await write(root, '09-course/units.jsonl', canonicalJsonl(assets.units));
  await write(root, '09-course/questions.jsonl', canonicalJsonl(assets.questions));
  await write(root, '09-course/practices.jsonl', canonicalJsonl(assets.practices));
  await write(root, '09-course/gates.jsonl', canonicalJsonl(assets.gates));
  for (const card of assets.cards) await write(root, `09-course/cards/${card.id}.md`, renderCard(card));
}

async function generateRcoreSmoke(root: string): Promise<void> {
  const projectId = 'project.rcore.tutorial-v3';
  const sourceIds = ['src.rcore.commit', 'src.rcore.syscall-mod'];
  const sources: PtkgSource[] = [
    { id: 'src.rcore.commit', type: 'source', source_kind: 'repo_commit', title: 'rCore-Tutorial-v3 fixed source', url: `${RCORE_REPO.replace(/\.git$/, '')}/tree/${RCORE_COMMIT}`, retrieved_at: '2026-08-07', version_or_ref: RCORE_COMMIT, trust_level: 'A', supports: ['跨仓库分析与课程编译冒烟'], tree_oid: RCORE_TREE },
    { id: 'src.rcore.syscall-mod', type: 'source', source_kind: 'repo_file', title: 'rCore syscall dispatcher', url: `${RCORE_REPO.replace(/\.git$/, '')}/blob/${RCORE_COMMIT}/os/src/syscall/mod.rs`, retrieved_at: '2026-08-07', version_or_ref: RCORE_COMMIT, trust_level: 'A', supports: ['教学内核 syscall 分发入口'], blob_oid: 'cd12de02619dc83e3b26fc791d2e2912d504b165' },
    { id: 'src.rcore.user-syscall', type: 'source', source_kind: 'repo_file', title: 'rCore user syscall wrappers', url: `${RCORE_REPO.replace(/\.git$/, '')}/blob/${RCORE_COMMIT}/user/src/syscall.rs`, retrieved_at: '2026-08-07', version_or_ref: RCORE_COMMIT, trust_level: 'A', supports: ['用户态 syscall 编号和包装'], blob_oid: '48b3e99c2589d1e057fc495c3075fc9100b58607' },
    STARRYOS_SHARED_SOURCES.find((item) => item.id === 'src.canonical.rust-no-std') as PtkgSource,
  ];
  const shared = STARRYOS_SHARED_NODES.find((item) => item.id === 'kc.rust.no-std.kernel-boundaries') as PtkgNode;
  const nodes: PtkgNode[] = [
    { id: projectId, type: 'project', title: 'rCore-Tutorial-v3 跨仓库分析冒烟', status: 'candidate', mission: '验证 PTKG 能在非 StarryOS 仓库固定源码、抽取事实并编译最小候选课程包。', repository: { url: RCORE_REPO, ref: RCORE_COMMIT }, curriculum_scope: { mode: 'pre_project_readiness', entry: '具备 Rust 基础', exit: '完成跨仓库源码分析 smoke gate', readiness_criteria: ['固定 commit/tree', '核实 syscall 教学入口', '编译 draft 包'], excluded_responsibilities: ['不声称这是完整 rCore 课程', '不分配真实项目任务'] }, outcomes: ['证明通用分析器和课程契约可跨仓库运行'], acceptance: { functional: ['编译和 draft 校验通过'], compatibility: ['不依赖 StarryOS 特例'], concurrency: [], quality: ['未决锚点保持 unresolved'] }, non_goals: ['不生成完整 rCore 课程'], source_ids: sourceIds },
    { id: 'outcome.rcore.analysis-smoke', type: 'outcome', title: '跨仓库源码分析与编译', status: 'candidate', project_value: '证明工具不局限于 cgroup 或 StarryOS。', system_boundary: '只核实固定源码、分析器输出和最小课程契约。', source_ids: sourceIds },
    { id: 'wp.rcore.analysis-smoke', type: 'work_package', title: '核实 rCore syscall 教学入口', status: 'candidate', parent_outcome_id: 'outcome.rcore.analysis-smoke', deliverables: ['固定源码记录', '事实/锚点摘要', 'draft 课程包'], definition_of_done: ['编译确定且 0 blocker'], source_ids: sourceIds },
    { id: 'competency.rcore.analysis-smoke', type: 'competency', title: '跨仓库定位 Rust syscall 入口', status: 'candidate', claim: '在固定 rCore-Tutorial-v3 commit 下，学生能够关联用户包装和内核分发入口，并用源码锚点说明 no_std 边界。', quality_criteria: ['commit/tree 固定', '事实只使用已读取文件', '歧义符号保留 unresolved'], source_ids: sourceIds },
    { id: 'practice.rcore.analysis-smoke', type: 'practice', title: 'rCore syscall 双端 trace', status: 'candidate', task_level: 'T1', scenario: '对照 user/src/syscall.rs 与 os/src/syscall/mod.rs 追踪一个教学 syscall。', deliverables: ['双端调用链', '固定源码证据'], tests: { positive: ['入口和分发编号对应'], negative: ['不存在编号不伪造实现'] }, uses_repo_artifacts: [{ repo: RCORE_REPO, ref: RCORE_COMMIT, path: 'os/src/syscall/mod.rs', role: '内核分发入口' }], source_ids: sourceIds },
    shared,
    { id: 'evidence.rcore.analysis-smoke', type: 'evidence', title: '跨仓库 trace 与编译报告', status: 'candidate', evidence_kind: 'code_trace', artifacts: ['调用链', '编译与 draft 校验结果'], collection: 'server_or_teacher_verified', mastery_weight: 'low', source_ids: sourceIds },
  ];
  const edges: PtkgEdge[] = [
    { id: 'edge.rcore.001', from: projectId, type: 'DECOMPOSES_TO', to: 'outcome.rcore.analysis-smoke', status: 'candidate' },
    { id: 'edge.rcore.002', from: 'outcome.rcore.analysis-smoke', type: 'DECOMPOSES_TO', to: 'wp.rcore.analysis-smoke', status: 'candidate' },
    { id: 'edge.rcore.003', from: 'wp.rcore.analysis-smoke', type: 'REQUIRES', to: 'competency.rcore.analysis-smoke', status: 'candidate', requirement_kind: 'required' },
    { id: 'edge.rcore.004', from: 'competency.rcore.analysis-smoke', type: 'PROVEN_BY', to: 'evidence.rcore.analysis-smoke', status: 'candidate' },
    { id: 'edge.rcore.005', from: 'evidence.rcore.analysis-smoke', type: 'ELICITED_BY', to: 'practice.rcore.analysis-smoke', status: 'candidate' },
    { id: 'edge.rcore.006', from: 'practice.rcore.analysis-smoke', type: 'REQUIRES', to: shared.id, status: 'candidate', requirement_kind: 'required' },
  ];
  const stage: CourseStage = { id: 'stage.rcore.smoke.tutorial', layer: 'tutorial', order: 0, title: '跨仓库源码分析', required: true, unit_ids: ['unit.rcore.analysis-smoke'], prerequisite_stage_ids: [], status: 'candidate', source_refs: sourceIds, content_hash: '' };
  const reference: CourseStage = { id: 'stage.rcore.smoke.project-reference', layer: 'project_reference', order: 10, title: 'rCore 项目上下文', required: false, unit_ids: [], prerequisite_stage_ids: [stage.id], status: 'candidate', source_refs: ['src.rcore.commit'], content_hash: '' };
  const questionIds = ['question.rcore.smoke.diagnostic.1', 'question.rcore.smoke.diagnostic.2', 'question.rcore.smoke.checkpoint.1', 'question.rcore.smoke.checkpoint.2'];
  const unit: CourseUnit = { id: 'unit.rcore.analysis-smoke', stage_id: stage.id, title: 'rCore syscall 跨仓库分析冒烟', required: true, node_ids: [projectId, 'outcome.rcore.analysis-smoke', shared.id], prerequisite_unit_ids: [], source_refs: sourceIds, origin_projects: [projectId], reuse_count: 2, dependency_depth: 1, card_ids: ['card.rcore.analysis-smoke'], question_ids: questionIds, practice_ids: ['course-practice.rcore.analysis-smoke'], gate_ids: ['gate.rcore.analysis-smoke'], status: 'candidate', generated_by: GENERATOR, content_hash: '' };
  const questionBase = { unit_ids: [unit.id], node_ids: unit.node_ids, source_refs: sourceIds, status: 'candidate' as const, generated_by: GENERATOR, content_hash: '' };
  const questions: CourseQuestion[] = [
    { ...questionBase, id: questionIds[0] as string, pool: 'diagnostic', type: 'choice', prompt: '内核 syscall 分发入口是？', options: ['os/src/syscall/mod.rs', 'user/src/syscall.rs'], answer: 'os/src/syscall/mod.rs', explanation: '用户文件包装调用，内核文件分发。', difficulty: 1 },
    { ...questionBase, id: questionIds[1] as string, pool: 'diagnostic', type: 'design', prompt: '为什么同名 symbol 多处出现时必须 unresolved？', options: [], answer: '声明歧义时无法唯一绑定源码事实，调用引用不能代替声明。', explanation: '锚点必须唯一解析。', difficulty: 2 },
    { ...questionBase, id: questionIds[2] as string, pool: 'checkpoint', type: 'code', prompt: '写出用户包装到内核分发的 trace。', options: [], answer: '记录编号、寄存器参数、trap、分发分支和返回值。', explanation: '双端 trace 验证跨仓库分析可用。', difficulty: 2 },
    { ...questionBase, id: questionIds[3] as string, pool: 'checkpoint', type: 'design', prompt: '哪些证据能证明本 smoke 可重放？', options: [], answer: '固定 commit/tree、事实和锚点 hash、编译 package root 与 draft findings。', explanation: '运行证据与源码身份必须同时存在。', difficulty: 3 },
  ];
  const practice: CoursePractice = { id: 'course-practice.rcore.analysis-smoke', unit_ids: [unit.id], node_ids: unit.node_ids, source_refs: sourceIds, kind: 'trace', title: 'rCore syscall 双端 trace', instructions: ['核对固定 commit/tree。', '读取用户包装和内核分发。', '追踪一个 syscall。', '记录歧义锚点而不猜测。', '编译并 draft 校验最小包。'], expected_evidence: ['固定源码', '调用链', '分析和编译摘要'], allowed_changes: ['仅临时 fixture'], safety: ['不修改远端仓库', '不上传 checkout'], status: 'candidate', generated_by: GENERATOR, content_hash: '' };
  const gate: CourseGate = { id: 'gate.rcore.analysis-smoke', stage_id: stage.id, unit_ids: [unit.id], prerequisite_gate_ids: [], evidence_kinds: ['fixed-source-analysis', 'draft-package'], pass_policy: '只确认跨仓库分析与编译链可用，不表示完整 rCore 课程已完成。', trusted_evidence: true, status: 'candidate', generated_by: GENERATOR, content_hash: '' };
  const card: Omit<CourseCard, 'file'> = { id: 'card.rcore.analysis-smoke', title: 'rCore-Tutorial-v3 跨仓库分析冒烟', unit_ids: [unit.id], node_ids: unit.node_ids, source_refs: sourceIds, status: 'candidate', generated_by: GENERATOR, body: `固定源码为 \`${RCORE_COMMIT}\` / tree \`${RCORE_TREE}\`。真实 project-init 抽取 1023 条事实，其中 5 条因非 Rust 符号能力降级为 unresolved；1018 个锚点中 956 个唯一验证，62 个歧义保持 unresolved。\n\n本样例只证明通用分析和课程编译契约跨仓库可用，不冒充完整 rCore 课程。`, content_hash: '' };
  await write(root, 'project-input.yaml', yaml({ spec_version: 'ptkg-project-input@1', workspace_id: projectId, status: 'candidate', repository: { locator: RCORE_REPO, kind: 'remote', requested_ref: RCORE_COMMIT, commit: RCORE_COMMIT, tree: RCORE_TREE }, goal: 'rCore-Tutorial-v3 跨仓库分析与课程编译冒烟', curriculum_boundary: 'pre_project_readiness', documents: [], unresolved_questions: [] }));
  await write(root, '07-projection/manifest.yaml', yaml({ ptkg_version: '0.1', bundle_id: 'ptkg.rcore.tutorial-v3.smoke', title: 'rCore-Tutorial-v3 cross-repository smoke', status: 'draft', language: 'zh-CN', created_at: '2026-08-07T00:00:00+08:00', curriculum_version: '0.1.0', project_ref: { repository_url: RCORE_REPO, git_ref: RCORE_COMMIT }, generator: { tool: '@os-camp/ptkg', authoring_kit_version: '0.4.0' }, approval: { status: 'draft', approved_by: null }, files: { nodes: 'nodes.jsonl', edges: 'edges.jsonl', sources: 'sources.jsonl' } }));
  await write(root, '07-projection/nodes.jsonl', canonicalJsonl(nodes));
  await write(root, '07-projection/edges.jsonl', canonicalJsonl(edges));
  await write(root, '07-projection/sources.jsonl', canonicalJsonl(sources));
  await write(root, '08-governance/review-events.jsonl', '');
  await write(root, '09-course/blueprint.yaml', yaml({ spec_version: 'course-blueprint@1', course_id: 'oscamp.rcore.tutorial-v3.smoke', version: '0.1.0', title: 'rCore-Tutorial-v3 跨仓库分析冒烟', language: 'zh-CN', stages: [stage, reference].map(({ content_hash: _hash, ...item }) => item) }));
  await write(root, '09-course/units.jsonl', canonicalJsonl([unit]));
  await write(root, '09-course/questions.jsonl', canonicalJsonl(questions));
  await write(root, '09-course/practices.jsonl', canonicalJsonl([practice]));
  await write(root, '09-course/gates.jsonl', canonicalJsonl([gate]));
  await write(root, `09-course/cards/${card.id}.md`, renderCard(card));
}

async function readJsonl<T>(file: string): Promise<T[]> {
  return (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

function mergeById<T extends { id: string }>(existing: T[], additions: T[]): T[] {
  const values = new Map(existing.map((item) => [item.id, item]));
  for (const item of additions) values.set(item.id, item);
  return [...values.values()];
}

async function syncCgroupSharedTrunk(fixturesRoot: string): Promise<void> {
  const root = path.join(fixturesRoot, 'authoring', 'cgroup-golden');
  const nodes = mergeById(
    await readJsonl<PtkgNode>(path.join(root, '07-projection', 'nodes.jsonl')),
    STARRYOS_SHARED_NODES,
  );
  const sources = mergeById(
    await readJsonl<PtkgSource>(path.join(root, '07-projection', 'sources.jsonl')),
    STARRYOS_SHARED_SOURCES,
  );
  const sharedEdges: PtkgEdge[] = [
    { id: 'edge.shared.001', from: 'practice.starryos.cgroup.trace-provider', type: 'REQUIRES', to: 'kc.os.build.reproducible-qemu', status: 'candidate', requirement_kind: 'required' },
    { id: 'edge.shared.002', from: 'practice.starryos.cgroup.trace-provider', type: 'REQUIRES', to: 'kc.rust.no-std.kernel-boundaries', status: 'candidate', requirement_kind: 'required' },
    { id: 'edge.shared.003', from: 'practice.starryos.cgroup.pids-vertical', type: 'REQUIRES', to: 'kc.os.process.lifecycle', status: 'candidate', requirement_kind: 'required' },
    { id: 'edge.shared.004', from: 'practice.starryos.cgroup.pids-vertical', type: 'REQUIRES', to: 'kc.os.concurrency.lock-and-lifetime', status: 'candidate', requirement_kind: 'required' },
    { id: 'edge.shared.005', from: 'practice.starryos.cgroup.pids-vertical', type: 'REQUIRES', to: 'kc.os.testing.four-way-evidence', status: 'candidate', requirement_kind: 'required' },
  ];
  const edges = mergeById(
    await readJsonl<PtkgEdge>(path.join(root, '07-projection', 'edges.jsonl')),
    sharedEdges,
  );
  const unitNodes: Record<string, string[]> = {
    'unit.starryos.cgroup.build-test-debug': ['kc.os.build.reproducible-qemu', 'kc.rust.no-std.kernel-boundaries', 'kc.os.testing.four-way-evidence'],
    'unit.starryos.cgroup.cgroupfs': ['kc.os.vfs.axfs-ng-vfs-traits'],
    'unit.starryos.cgroup.membership': ['kc.os.process.lifecycle', 'kc.os.concurrency.lock-and-lifetime'],
    'unit.starryos.cgroup.pids-vertical': ['kc.os.process.lifecycle', 'kc.os.concurrency.lock-and-lifetime', 'kc.os.testing.four-way-evidence'],
    'unit.starryos.cgroup.concurrency': ['kc.os.concurrency.lock-and-lifetime', 'kc.os.testing.four-way-evidence'],
  };
  const units = (await readJsonl<CourseUnit>(path.join(root, '09-course', 'units.jsonl'))).map((unit) => ({
    ...unit,
    node_ids: [...new Set([...unit.node_ids, ...(unitNodes[unit.id] ?? [])])],
  }));
  await write(root, '07-projection/nodes.jsonl', canonicalJsonl(nodes));
  await write(root, '07-projection/edges.jsonl', canonicalJsonl(edges));
  await write(root, '07-projection/sources.jsonl', canonicalJsonl(sources));
  await write(root, '09-course/units.jsonl', canonicalJsonl(units));
}

export async function generateG5Fixtures(fixturesRoot = path.join(ROOT, 'fixtures')): Promise<void> {
  await syncCgroupSharedTrunk(fixturesRoot);
  await generateAbiWorkspace(path.join(fixturesRoot, 'authoring', 'starryos-abi-golden'));
  await generateRcoreSmoke(path.join(fixturesRoot, 'authoring', 'rcore-tutorial-smoke'));
  await write(fixturesRoot, 'smoke/rcore-tutorial-v3-analysis.json', `${canonicalJson({
    spec_version: 'ptkg-analysis-smoke@1', repository: RCORE_REPO, commit: RCORE_COMMIT, tree: RCORE_TREE,
    analyzed_at: '2026-08-07', facts: { total: 1023, candidate: 1018, unresolved: 5 },
    anchors: { total: 1018, verified: 956, unresolved: 62 },
    parser_capabilities: { git_tree: true, rust_declaration: 'builtin', rust_analyzer: 'not_required' },
    hashes: {
      project_input_sha256: '37fc2d0a8b92cf0592d3be483d1fa470f6af99d8940c15ad509ca65e09c4c29f',
      code_facts_sha256: '0d574db04c711a9a6128322a36d32390053f34a2234cd163280a9cd405c223ec',
      anchor_verification_sha256: '9172d9de37620780c2e771a413886b5e447f6ca2b65ac3b314b9b64e5ec0530d',
      source_contract_sha256: 'f5a92fc22883c8c03f87b391238c24d94fefc135b8d15c49d23f285a75c58008',
    },
    boundary: 'analysis_and_compile_smoke_only', status: 'candidate',
  })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateG5Fixtures();
  process.stdout.write('G5 fixtures generated.\n');
}
