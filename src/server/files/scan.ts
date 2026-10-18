import "server-only";
import { env } from "../env";

/*
 * Malware scanning of uploads, behind one interface. No scanning engine is connected yet, so the
 * default ("none") scans nothing and every stored file is recorded as NOT_SCANNED — never as clean.
 * Production needs a real engine (e.g. ClamAV via clamd, or a cloud scanning API) implemented as
 * another MalwareScanner and selected with MALWARE_SCANNER; until then uploads are only checked
 * for type, size, content signature and (Office) macros.
 *
 *   none — no scan; files are stored as NOT_SCANNED.
 *   test — deterministic, for tests: the EICAR test string is "infected", anything else is clean.
 */

export type ScanResult = { status: "CLEAN"; scanner: string } | { status: "INFECTED"; scanner: string; signature: string } | { status: "NOT_SCANNED" };

export interface MalwareScanner {
  readonly name: string;
  scan(data: Buffer): Promise<ScanResult>;
}

export class NoMalwareScanner implements MalwareScanner {
  readonly name = "none";
  async scan(): Promise<ScanResult> {
    return { status: "NOT_SCANNED" };
  }
}

/** The industry-standard antivirus test string (harmless). */
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export class TestMalwareScanner implements MalwareScanner {
  readonly name = "test";
  async scan(data: Buffer): Promise<ScanResult> {
    return data.includes(EICAR) ? { status: "INFECTED", scanner: this.name, signature: "EICAR-Test-File" } : { status: "CLEAN", scanner: this.name };
  }
}

let scanner: MalwareScanner | undefined;

/** The configured scanner (MALWARE_SCANNER), created once per process. */
export function malwareScanner(): MalwareScanner {
  scanner ??= env().MALWARE_SCANNER === "test" ? new TestMalwareScanner() : new NoMalwareScanner();
  return scanner;
}
