import * as vscode from 'vscode';

/**
 * This module deliberately imports nothing from `modules/`.
 *
 * `app.ts` builds the singleton at import time, and every `modules/` entry
 * reaches `app` again through `logger` -> `ui/output`. Pulling the pause state
 * in from here would close that cycle and run the constructor against a
 * half-initialised module. The state is pushed in through
 * {@link setPausedState} instead — the UI is told what to show, it doesn't go
 * looking for it.
 */

const spinners = {
  dots: {
    interval: 80,
    frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  },
};

enum Status {
  ok = 1,
  warn,
  error,
}

const PAUSE_ICON = '$(debug-pause)';
const PAUSE_TOOLTIP =
  'Automatic sync is paused: saves, watchers and renames are not mirrored to the remote.\n' +
  'Run "SFTP: Resume Auto Sync" (or "SFTP: Toggle Auto Sync") to resume it.';

export default class StatusBarItem {
  static Status = Status;

  private _name: () => string | string;
  private tooltip: string;
  private statusBarItem: vscode.StatusBarItem;
  private spinnerTimer: any = null;
  private resetTimer: any = null;
  private curFrameOfSpinner: number = 0;
  private text!: string;
  private status: Status = Status.ok;
  private detail: string | null = null;
  private queueSize: number = 0;
  private paused: boolean = false;
  // true while a transient showMsg text owns the item, so the decorations
  // below never rewrite a message the caller composed
  private showingMsg: boolean = false;
  private spinner: {
    interval: number;
    frames: string[];
  };

  constructor(name, tooltip, command) {
    this._name = name;
    this.tooltip = tooltip;
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    this.statusBarItem.command = command;
    this.spinner = spinners.dots;
    this.reset = this.reset.bind(this);
    this.reset();
  }

  private get name() {
    return typeof this._name === 'function' ? this._name() : this._name;
  }

  updateStatus(status: Status) {
    this.status = status;
    this._render();
  }

  /**
   * Extra suffix appended to the base text, e.g. `SFTP: produccion $(debug-pause)`.
   * Ignored while a `showMsg` is on screen. Pass null to clear it.
   */
  setDetail(detail: string | null) {
    const next = detail ? detail : null;
    if (this.detail === next) {
      return;
    }

    this.detail = next;
    this._render();
  }

  /** Reflects the automatic-sync pause. Pushed in by syncControl. */
  setPausedState(paused: boolean) {
    if (this.paused === paused) {
      return;
    }

    this.paused = paused;
    this._render();
  }

  /** Pending transfers, rendered as `SFTP: produccion (3)`. 0 hides the hint. */
  setQueueSize(n: number) {
    const next = n > 0 ? n : 0;
    if (this.queueSize === next) {
      return;
    }

    this.queueSize = next;
    this._render();
  }

  getText() {
    return this.statusBarItem.text;
  }

  show() {
    this.statusBarItem.show();
  }

  isSpinning() {
    return this.spinnerTimer !== null;
  }

  startSpinner() {
    if (this.spinnerTimer) {
      return;
    }

    const totalFrame = this.spinner.frames.length;
    this.spinnerTimer = setInterval(() => {
      this.curFrameOfSpinner = (this.curFrameOfSpinner + 1) % totalFrame;
      this._render();
    }, this.spinner.interval);
    this._render();
  }

  stopSpinner() {
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
    this.curFrameOfSpinner = 0;
    this._render();
  }

  showMsg(text: string, hideAfterTimeout?: number);
  showMsg(text: string, tooltip: string, hideAfterTimeout?: number);
  showMsg(text: string, tooltip?: string | number, hideAfterTimeout?: number) {
    if (typeof tooltip === 'number') {
      hideAfterTimeout = tooltip;
      tooltip = text;
    }

    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }

    this.showingMsg = true;
    this.text = text;
    this.statusBarItem.tooltip = tooltip;
    this._render();
    if (hideAfterTimeout) {
      this.resetTimer = setTimeout(this.reset, hideAfterTimeout);
    }
  }

  private _render() {
    if (this.isSpinning()) {
      this.statusBarItem.text = this.spinner.frames[this.curFrameOfSpinner] + ' ' + this.text;
      return;
    }

    let text: string;
    if (this.name === this.text) {
      switch (this.status) {
        case Status.ok:
          text = this.text;
          break;
        case Status.warn:
          text = `$(alert) ${this.text}`;
          break;
        case Status.error:
          text = `$(issue-opened) ${this.text}`;
          break;
        default:
          text = this.text;
      }
    } else {
      text = this.text;
    }

    if (this.showingMsg) {
      this.statusBarItem.text = text;
      return;
    }

    this.statusBarItem.text = this._decorate(text);
    this.statusBarItem.tooltip = this._buildTooltip();
  }

  private _decorate(text: string) {
    let decorated = text;
    if (this.queueSize > 0) {
      decorated += ` (${this.queueSize})`;
    }
    if (this.paused) {
      decorated += ` ${PAUSE_ICON}`;
    }
    if (this.detail) {
      decorated += ` ${this.detail}`;
    }

    return decorated;
  }

  private _buildTooltip() {
    const extra: string[] = [];
    if (this.paused) {
      extra.push(PAUSE_TOOLTIP);
    }
    if (this.queueSize > 0) {
      extra.push(`${this.queueSize} pending transfer(s).`);
    }

    if (extra.length <= 0) {
      return this.tooltip;
    }

    return [this.tooltip].concat(extra).join('\n');
  }

  reset() {
    this.showingMsg = false;
    this.text = this.name;
    this.statusBarItem.tooltip = this.tooltip;
    this._render();
  }
}
