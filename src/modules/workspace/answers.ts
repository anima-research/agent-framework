import { constants } from 'node:os';
import { boundedErrorMessage } from '../../error-message.js';

export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Refusal';
  }
}

export function didNothing(tool: string, body: string, to?: string): string {
  return `The ${tool} did nothing${to !== undefined ? ` to ${JSON.stringify(to)}` : ''}: ${body}`;
}

export function onlyTheHost(can: string): string {
  return `Calling again won't change that; whoever runs this host can ${can}.`;
}

// Node's own message for a failed system call names the host's absolute
// path, so an agent gets the code's plain words instead.
export function errnoWords(code: string | undefined): string {
  switch (code) {
    case 'ENOENT': return 'nothing is there';
    case 'ENOTDIR': return 'a part of the path isn\'t a directory';
    case 'EACCES': return 'permission denied';
    case 'EPERM': return 'not permitted';
    case 'EISDIR': return 'it\'s a directory';
    case 'EEXIST': return 'something is already there';
    case 'ENOTEMPTY': return 'the directory isn\'t empty';
    case 'EXDEV': return 'the move would cross from one filesystem to another';
    case 'ELOOP': return 'too many symlinks, or a loop of them';
    case 'ENAMETOOLONG': return 'a name too long for the filesystem';
    case 'ENOSPC': return 'no space left on the disk';
    case 'EDQUOT': return 'the disk quota is used up';
    case 'EFBIG': return 'the file would be too large for the filesystem';
    case 'EROFS': return 'the filesystem is read-only';
    case 'EIO': return 'an input/output error on the disk';
    case 'EBUSY': case 'ETXTBSY': return 'the file is busy';
    case 'EMFILE': case 'ENFILE': return 'too many files are open on this host';
    case 'ENOMEM': return 'this host is out of memory';
    case 'EAGAIN': case 'EWOULDBLOCK': return 'the system was busy';
    case 'EINTR': return 'the system call was interrupted';
    case 'ETIMEDOUT': return 'the system call timed out';
    case 'ESTALE': return 'a stale network file handle';
    case 'EINVAL': return 'the system refused an argument as invalid';
    case undefined: return 'an error the system gave no code for';
    default: return `a system error (${code})`;
  }
}

export function hostFix(code: string | undefined): string | undefined {
  switch (code) {
    case 'ENOSPC': return 'free space on its disk';
    case 'EFBIG': return 'raise the limit on a file\'s size, or keep the files on a filesystem that holds larger ones';
    case 'EDQUOT': return 'raise or free the disk quota';
    case 'EROFS': return 'make the filesystem writable';
    case 'EIO': return 'check the disk';
    case 'EACCES': case 'EPERM': return 'change the permissions';
    case 'EMFILE': case 'ENFILE': return 'raise the limit on open files';
    case 'ELOOP': return 'fix the symlinks on that path';
    case 'ENOMEM': return 'free memory';
    default: return undefined;
  }
}

const PASSING = new Set(['EIO', 'EMFILE', 'ENFILE', 'ENOMEM']);
const AS_DISK_IS = new Set(['EISDIR', 'ENOTDIR', 'EEXIST', 'ENOTEMPTY', 'EXDEV']);

export function systemWords(code: string | undefined, error: unknown): string {
  return code !== undefined ? errnoWords(code) : boundedErrorMessage(error);
}

export function errnoWayOn(code: string | undefined, otherwise = 'Calling again may work.', hostsName = false): string {
  if (code === 'ENAMETOOLONG' && hostsName) return onlyTheHost("give the mount's directory a shorter path");
  const fix = hostFix(code);
  if (fix !== undefined) {
    return code !== undefined && PASSING.has(code) ? `Calling again may work; if it fails the same way, whoever runs this host can ${fix}.` : onlyTheHost(fix);
  }
  if (code === 'ENAMETOOLONG') return "Calling again won't change that; a shorter name would.";
  if (code !== undefined && AS_DISK_IS.has(code)) return "Calling again won't change that while disk holds what it does there.";
  return otherwise;
}

const OS_ERRNO = new Map<number, string>();
for (const [name, number] of Object.entries(constants.errno)) if (!OS_ERRNO.has(number)) OS_ERRNO.set(number, name);

// Chronicle's store errors carry the code GenericFailure, and an I/O
// failure's message is "IO error: " and Rust's std::io::Error, which ends
// with the OS error's number: an errno on POSIX, a Win32 code on Windows.
export function errnoCode(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) return code;
  const os = error instanceof Error && process.platform !== 'win32' ? /^IO error: .*\(os error (\d+)\)$/s.exec(error.message) : null;
  return os !== null ? OS_ERRNO.get(Number(os[1])) : undefined;
}

const CHANGING = new Set(['write', 'edit', 'edit_many', 'delete', 'materialize', 'sync']);

export function changesFiles(tool: string): boolean {
  return CHANGING.has(tool);
}

export const ROOT_RECHECK = "Calling again may work; if it fails the same way, whoever runs this host can check the mount's directory and its path.";

export const ROOT_UNCHECKED = "Calling again won't change that while the mount's directory is gone from its path, and checks it afresh otherwise; whoever runs this host can check the directory and its path.";

export const AWAITS_REOPEN = "The workspace can't check its files against disk until its store is reopened, so calling again won't change that; whoever runs this host can reopen it with a restart.";

export interface Unexpected {
  stored?: 'unknown' | 'not' | 'held';
  said?: string;
  reopen?: boolean;
  look?: string;
}

export function unexpectedAnswer(tool: string, subject: string | undefined, error: unknown, how: Unexpected = {}): string {
  const stored = how.stored ?? 'unknown';
  const code = errnoCode(error);
  const words = how.said ?? systemWords(code, error);
  const before = stored !== 'not' ? '' : tool === 'edit_many' ? ', before any of its edits was stored' : `, before the ${tool === 'delete' ? 'deletion' : tool} was stored`;
  const head = `The ${tool}${subject !== undefined ? ` of ${subject}` : ''} stopped on an error the workspace didn't expect${before}: ${words.replace(/\.$/, '')}.`;
  if (stored === 'held') {
    return `${head} ${subject !== undefined ? subject : 'Its files'} already held what the call gave, so ${subject !== undefined ? 'it holds' : 'they hold'} that in the workspace either way.`;
  }
  const changing = stored === 'unknown' && CHANGING.has(tool);
  if (how.reopen === true) return [head, AWAITS_REOPEN, ...(changing ? ["Whether it changed anything isn't known until then."] : [])].join(' ');
  const look = !changing ? null
    : how.look ?? (subject === undefined ? 'read its files to see what they hold now' : `read ${subject} to see what the workspace holds there now`);
  const on = code !== undefined
    ? errnoWayOn(code, "Calling again may work; if it fails the same way, whoever runs this host can find the whole error in this host's log.")
    : "Calling again may work; if it fails the same way, whoever runs this host can find the whole error in this host's log.";
  return [head, ...(look !== null ? [`Whether it changed anything isn't known: ${look}.`] : []), on].join(' ');
}
