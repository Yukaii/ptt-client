import EventEmitter from 'eventemitter3';
import sleep from 'sleep-promise';
import Terminal from 'terminal.js';

import key from '../../utils/keyboard';
import {
  getWidth,
  indexOfWidth,
  substrWidth,
} from '../../utils/char';

import defaultConfig from './config';

const setIntevalUntil = (async (_func, _validate, _inteval) => {
  await sleep(_inteval);
  let ret = await _func();
  if (_validate(ret)) return ret;
  else return setIntevalUntil(_func, _validate, _inteval);
});

class Bot extends EventEmitter {
  static initialState = {
    login: false,
  };
  static forwardEvents = [
    'connect',
    'disconnect',
    'message',
    'error',
  ];
  constructor(config) {
    super();
    config = {...defaultConfig, ...config};

    this._term = new Terminal(config.terminal);
    this._state = { ...Bot.initialState };
    this._term.state.setMode('stringWidth', 'dbcs');

    let Socket;
    switch (config.protocol.toLowerCase()) {
      case 'websocket':
      case 'ws':
      case 'wss':
        Socket = require("../../core/socket").default;
        break;
      case 'telnet':
      case 'ssh':
      default:
        Socket = null;
    }

    if (Socket === null) {
      throw `Invalid protocol: ${config.protocol}`;
    }

    const socket = new Socket(config);
    socket.connect();

    Bot.forwardEvents.forEach(e => {
      socket.on(e, this.emit.bind(this, e));
    });
    socket
      .on('message', (msg) => {
        this._term.write(msg);
        this.emit('redraw', this._term.toString());
      })
      .on('disconnect', (close) => {
      })
      .on('error', (err) => {
        console.log(err);
      });
    this.socket = socket;
    this.config = config;
  }

  get state() {
    return {...this._state};
  }

  getLine = (n) => {
    return this._term.state.getLine(n);
  };

  async send(msg) {
    this.config.preventIdle && this.preventIdle();
    return new Promise(resolve => {
      this.socket.send(msg);
      this.once('message', msg => {
        resolve(msg);
      });
    });
  }

  preventIdle(timeout = 60) {
    clearTimeout(this.preventIdleHandler);
    this.preventIdleHandler = setTimeout(() => {
      this.send(`${key.CtrlU}${key.ArrowLeft}`);
    }, timeout * 1000);
  }

  async login(username, password) {
    if (this._state.login) return;
    username = username.replace(/,/g, '');
    await this.send(`${username},${key.Enter}${password}${key.Enter}`);
    let ret;
    while ((ret = await this._checkLogin()) === null) {
      await sleep(400);
    }
    if (ret) {
      const { _state: state } = this;
      state.login = true;
      state.position = {
        boardname: "",
      };
      this.emit('stateChange', this.state);
    }
    return ret;
  }

  async _checkLogin() {
    const { getLine } = this;

    if (getLine(21).str.includes("密碼不對或無此帳號")) {
      this.emit('login.failed');
      return false;
    } else if ((getLine(22).str+getLine(23).str).toLowerCase().includes("y/n")) {
    //} else if (getLine(22).str.includes("您想刪除其他重複登入的連線嗎")) {
      await this.send(`y${key.Enter}`);
    } else if (getLine(23).str.includes("請勿頻繁登入以免造成系統過度負荷")) {
      await this.send(`${key.Enter}`);
    } else if (getLine(23).str.includes("按任意鍵繼續")) {
      await this.send(`${key.Enter}`);
    } else if (getLine(23).str.includes("您要刪除以上錯誤嘗試的記錄嗎")) {
      await this.send(`y${key.Enter}`);
    } else if (getLine(23).str.includes("我是")) {
      this.emit('login.success');
      return true;
    } else {
      await this.send(`q`);
    }
    return null;
  }

  async getArticles(boardname, offset=0) {
    await this.enterBoard(boardname);
    offset |= 0;
    if (offset > 0) {
      offset = Math.max(offset-9, 1);
      await this.send(`${key.End}${key.End}${offset}${key.Enter}`);
    }
    const { getLine } = this;
    let articles = [];
    for(let i=3; i<=22; i++) {
      const line = getLine(i).str;
      const article = {
        sn:     substrWidth('dbcs', line, 1,   7).trim() | 0,
        push:   substrWidth('dbcs', line, 9,   2).trim(),
        date:   substrWidth('dbcs', line, 11,  5).trim(),
        author: substrWidth('dbcs', line, 17, 12).trim(),
        status: substrWidth('dbcs', line, 30,  2).trim(),
        title:  substrWidth('dbcs', line, 32    ).trim(),
        fixed:  substrWidth('dbcs', line, 1,   7).trim().includes('★'),
      };
      articles.push(article);
    }
    // fix sn
    if (articles.length >= 2 && articles[0].sn === 0) {
      for(let i=1; i<articles.length; i++) {
        if (articles[i].sn !== 0) {
          articles[0].sn = articles[i].sn - i;
          break;
        }
      }
    }
    for(let i=1; i<articles.length; i++) {
      articles[i].sn = articles[i-1].sn+1;
    }
    await this.enterIndex();
    return articles.reverse();
  }

  async getArticle(boardname, sn) {
    await this.enterBoard(boardname);
    const { getLine } = this;

    await this.send(`${sn}${key.Enter}${key.Enter}`);

    let article = {
      sn,
      author:    substrWidth('dbcs', getLine(0).str, 7, 50).trim(),
      title:     substrWidth('dbcs', getLine(1).str, 7    ).trim(),
      timestamp: substrWidth('dbcs', getLine(2).str, 7    ).trim(),
      lines: [],
    };

    article.lines.push(getLine(0).str);

    while (!getLine(23).str.includes("100%")) {
      for(let i=1; i<23; i++) {
        article.lines.push(getLine(i).str);
      }
      await this.send(key.PgDown);
    }

    const lastLine = article.lines[article.lines.length-1];
    for(let i=0; i<23; i++) {
      if (getLine(i).str == lastLine) {
        for(let j=i+1; j<23; j++) {
          article.lines.push(getLine(j).str);
        }
        break;
      }
    }

    await this.enterIndex();
    return article;
  }

  async getFavorite() {
    await this.enterFavorite();
    const { getLine } = this;

    const favorites = [];

    for(let i=3; i<23; i++) {
      let line = getLine(i).str;
      if (line.trim() === '') break;
      let favorite = {
        bn:        substrWidth('dbcs', line,  3,  4).trim() | 0,
        read:      substrWidth('dbcs', line,  8,  2).trim() === '',
        boardname: substrWidth('dbcs', line, 10, 12).trim(),
        category:  substrWidth('dbcs', line, 23,  4).trim(),
        title:     substrWidth('dbcs', line, 30, 31),
        users:     substrWidth('dbcs', line, 62,  5).trim(),
        admin:     substrWidth('dbcs', line, 67    ).trim(),
        folder:    false,
        divider:   false,
      };
      switch (favorite.boardname) {
        case 'MyFavFolder':
          favorite = {
            ...favorite,
            title:  substrWidth('dbcs', line, 30),
            users: '',
            admin: '',
            folder: true,
          };
          break;
        case '------------':
          favorite = {
            ...favorite,
            title:  substrWidth('dbcs', line, 30),
            users: '',
            admin: '',
            divider: true,
          };
          break;
        default:
          break;
      }
      favorites.push(favorite);
    }

    await this.enterIndex();
    return favorites;
  }

  async enterIndex() {
    await this.send(`${key.ArrowLeft.repeat(10)}`);
    return true;
  }

  async enterBoard(boardname) {
    await this.send(`s${boardname}${key.Enter} ${key.Home}${key.End}`);
    boardname = boardname.toLowerCase();
    const { getLine } = this;
    
    if (getLine(23).str.includes("按任意鍵繼續")) {
      await this.send(` `);
    }
    if (getLine(0).str.toLowerCase().includes(`${boardname}`)) {
      this._state.position.boardname = boardname;
      this.emit('stateChange', this.state);
      return true;
    }
    return false;
  }

  async enterFavorite() {
    await this.send(`F${key.Enter}`);
    return true;
  }
}

export default Bot;
