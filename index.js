const EventEmitter = require('events').EventEmitter
const path = require('path')
const fs = require('fs')
const spawn = require('child_process').spawn

function pad(str, width) {
    var len = Math.max(0, width - str.length);
    return str + Array(len + 1).join(' ');
}
function humanReadableArgName(arg) {
    var nameOutput = arg.name + (arg.variadic === true ? '...' : '');

    return arg.required
        ? '<' + nameOutput + '>'
        : '[' + nameOutput + ']'
}

class Option {
    constructor(flags, description) {
        const arr = flags.split(/[, |]+/)
        const short = arr.find(flag => flag[0] === '-' && flag[1] !== '-')
        const long = arr.find(flag => /^--/.test(flag))
        const required = ~flags.indexOf('<')
        const optional = ~flags.indexOf('[')
        const isNo = ~long.indexOf('--no-')
        const alias = short && short.replace(/^-/, '')

        Object.assign(this, {
            flags,
            short,
            long,
            required,
            optional,
            isNo,
            alias,
        })
    }
    name() {
        return this.long.replace(/^--(no-)?/, '')
            .replace(/-(\w)/g, (item, $0) => $0.toUpperCase())
    }
    is(arg) {
        return arg === this.short || arg === this.long
    }
}

class Arg {
    constructor(arg) {
        this.required = false
        this.name = ''
        this.variadic = false

        switch (arg[0]) {
            case '<':
                this.required = true
                this.name = arg.slice(1, -1)
                break
            case '[':
                this.name = arg.slice(1, -1)
                break
        }

        if (this.name.length > 3 && this.name.slice(-3) === '...') {
            this.variadic = true
            this.name = this.name.slice(0, -3)
        }
    }
}

class Command extends EventEmitter {
    constructor(name = '') {
        super()
        this.commands = []
        this._name = name
        this.options = []
        this._noHelp = false
        this._args = []
        this.hasSubCommand = false
        this._execs = {}
    }
    name(name) {
        if (arguments.length) {
            this._name = name
            return this
        }
        else {
            return this._name
        }
    }
    parse(argv) {
        if (this.hasSubCommand) this.addImplicitHelpCommand()

        this._name = this._name || path.basename(argv[1], '.js')

        if (this.hasSubCommand && argv.length < 3 && !this.defaultCommand) {
            argv.push('--help')
        }

        const parsed = this.parseOptions(this.normalize(argv.slice(2)))
        const args = this.args = parsed.args

        const result = this.parseArgs(args, parsed.unknown)

        const name = result.args[0]
        let alias
        if (name) {
            alias = this.commands.find(command => command.alias() === name)
        }

        // 如果匹配带有 desc 的 command
        if (this._execs[name]) {
            this.executeSubCommand(argv, args, parsed.unknown)
        }
        // 如果匹配带有 desc 的 command 的 alias
        else if (alias) {
            // 转 alias 为 command 的本名
            args[0] = alias.name()
            this.executeSubCommand(argv, args, parsed.unknown)
        }
        // 如果设置了默认 command
        else if (this.defaultCommand) {
            args.unshift(this.defaultCommand)
            this.executeSubCommand(argv, args, parsed.unknown)
        }
    }
    normalize(args) {
        let result = []
        let lastOption

        for (let i = 0; i < args.length; i++) {
            const arg = args[i]

            if (arg === '--') {
                // 如果发现 '--' 则剩余参数不做处理，直接 slice
                result = result.concat(args.slice(i))
                break;
            }

            if (lastOption && lastOption.required) {
                result.push(arg)
                lastOption = null
            }
            else if (~arg.indexOf('=')) {
                arg.split('=').forEach(flag => {
                    result.push(flag)
                })
            }
            else if (arg.length > 1 && arg[0] === '-' && arg[1] !== '-') {
                arg.slice(1).split('').forEach(flag => {
                    result.push(`-${flag}`)
                })
            }
            else {
                result.push(arg)
                lastOption = this.getOptionByLongFlag(arg)
            }
        }
        return result
    }
    // 找出哪些是 option，哪些是 arg
    parseOptions(argv = []) {
        const args = []
        const unknown = []
        let literal = false

        for (let i = 0; i < argv.length; i++) {
            const arg = argv[i]

            // 发现 --，则后面的都作为 option 的参数，即 arg
            if (literal) {
                args.push(arg)
                continue
            }

            if (arg === '--') {
                literal = true
                continue
            }

            const option = this.optionFor(arg)

            // 是 option
            if (option) {
                // option 的参数是必须的场景
                if (option.required) {
                    const arg = argv[++i]
                    // 没有传必须的参数，则报错
                    if (arg == null) {
                        return this.optionMissingArg(option)
                    }
                    else {
                        this.emit(`option:${option.name()}`, arg)
                    }
                }
                // option 的参数是可选的场景
                else if (option.optional) {
                    const arg = argv[i + 1]
                    // 如果有可选参数，则传入参数
                    if (arg) {
                        this.emit(`option:${option.name()}`, arg)
                        i++
                    }
                    else {
                        this.emit(`option:${option.name()}`)
                    }
                }
                else {
                    const name = `option:${option.name()}`
                    this.emit(name)
                }
            }
            // 看起来像 option
            else if (arg.length > 1 && arg[0] === '-') {
                unknown.push(arg)

                // 看起来像 option 的参数
                if (argv[i + 1] && argv[i + 1][0] !== '-') {
                    unknown.push(argv[++i])
                }
            }
            // 剩余的不是 option 又不像 option 的被当做参数
            else {
                args.push(arg)
            }
        }

        // 排除 option 后剩余的
        // 其中 args 作为参数被 parseArg 作为 command 消费
        return { args, unknown }
    }
    parseArgs(args, unknown) {
        // 如果有 args 则尝试作为 command
        if (args.length) {
            const name = `command:${args[0]}`

            // 检测之前是否注册了对应的 command
            if (this.listeners(name).length) {
                args.shift()
                this.emit(name, args, unknown)
            }
            else {
                this.emit('command:*', args)
            }
        }
        else {
            this.outputHelpIfNecessary(unknown)

            // 如果没有 args 却有未知的 options 则报错
            if (unknown.length) {
                this.unknownOption(unknown)
            }
        }

        return this
    }
    command(flag, desc, opts = {}) {
        const args = flag.split(' ')

        const cmd = new Command(args.shift())

        if (desc) {
            // 有 desc 的 command 才能有帮助输出
            this.hasSubCommand = true
            this._execs[cmd.name()] = true
            cmd.description(desc)
        }

        if (opts.isDefault) {
            this.defaultCommand = cmd.name()
        }

        cmd.setExpectedArgs(args)
        this.commands.push(cmd)

        if (opts.noHelp) {
            cmd._noHelp = true
        }

        cmd.parent = this

        // @ TODO 为什么要这么搞呢？
        // 因为有 desc 的是作为 sub-command 的
        if (desc) return this
        return cmd
    }
    setExpectedArgs(args) {
        this._args = args.map(arg => new Arg(arg)).filter(arg => arg.name)
    }
    alias(alias) {
        let command

        // 如果有多个 commands 的话，则 alias 是最新的那个 command 的
        if (this.commands.length) {
            command = this.commands[this.commands.length - 1]
        }
        // 否则，则是当前 command 的
        else {
            command = this
        }

        if (!arguments.length) {
            return this._alias
        }

        command._alias = alias
        return this
    }
    description(desc) {
        if (arguments.length) {
            this._description = desc
            return this
        }
        else {
            return this._description
        }
    }
    action(callback) {
        const parent = this.parent || this
        const name = parent === this ? '*' : this.name()
        const listener = (args, unknown) => {
            // 在这里会再用当前的 Command 寻找一次 options
            const parsed = this.parseOptions(unknown)

            if (parsed.unknown.length) {
                this.unknownOption(parsed.unknown)
            }

            if (parsed.args.length) {
                args = parsed.args.concat(args)
            }

            this._args.forEach((arg, i, list) => {
                if (arg.required && args[i] == null) {

                }
                else if (arg.variadic) {
                    const isLast = i === list.length - 1
                    if (isLast) {
                        args[i] = args.splice(i)
                    }
                    else {
                        this.variadicArgNotLast(arg.name);
                    }
                }
            })

            if (this._args.length) {
                args[this._args.length] = this
            }
            else {
                args.push(this)
            }

            callback.apply(this, args)
        }
        parent.on(`command:${name}`, listener)
        if (this._alias) {
            parent.on(`command:${this._alias}`, listener)
        }

        return this
    }
    version(version) {
        this._version = version
        this.option('-V --version')
        this.on('option:version', () => {
            console.log(this._version)
            process.exit(0)
        })
        return this
    }
    arguments(desc) {
        this._arguments = null
        return this
    }
    option(flags, description, fn, defaultValue) {
        if (typeof fn !== 'function') {
            if (fn instanceof RegExp) {
                const regexp = fn
                fn = val => {
                    const result = regexp.exec(val)
                    return result ? result[0] : defaultValue
                }
            }
            else {
                defaultValue = fn
                fn = null
            }
        }
        const option = new Option(flags, description)

        this.options.push(option)

        // 只有是 --no 开头，是optional，或者是 requred 这三种的才在初始时赋值
        if (option.isNo || option.optional || option.required) {
            // 以 --no-*开头的，赋值为 true
            if (option.isNo) {
                this[option.name()] = defaultValue || true
            }
            if (defaultValue !== undefined) {
                this[option.name()] = defaultValue
            }
        }

        const name = `option:${option.name()}`

        this.on(name, value => {
            if (fn) {
                value = fn(value, this[option.name()] === undefined ? defaultValue : this[option.name()])
            }
            // 如果 value 没有值，则赋值为 bool
            if (value == null) {
                // 如果是 --no-* 则赋值为 false
                // 否则赋值为 defaultValue 或者 true
                this[option.name()] = option.isNo ? false : defaultValue || true
            }
            // 如果 value 有值，则直接赋值
            else {
                this[option.name()] = value
            }
        })
        return this
    }
    unknownOption(flag) {
        if (this._allowUnknownOption) { return }
        console.error();
        console.error("  error: unknown option `%s'", flag);
        console.error();
        process.exit()
    }
    allowUnknownOption() {
        this._allowUnknownOption = true
        return this
    }
    outputHelp(cb) {
        if (!cb) {
            cb = function (passthru) {
                return passthru;
            }
        }
        process.stdout.write(cb(this.helpInformation()));
        this.emit('--help');
    }
    helpInformation() {
        const cmdName = this._name
        const usage = [
            '',
            '  Usage: ' + cmdName + ' ' + this.usage(),
            '',
        ]

        const desc = this._description ? [
            '  ' + this._description
            , ''
        ] : []

        const options = [
            '',
            '  Options:',
            '',
            '' + this.optionHelp().replace(/^/gm, '    '),
            '',
        ]

        const commandHelp = this.commandHelp()
        const cmds = commandHelp ? [commandHelp] : []

        return usage
            .concat(desc)
            .concat(options)
            .concat(cmds)
            .join('\n')
    }
    usage() {
        const args = this._args.map(arg => humanReadableArgName(arg))

        const usage = [
            '[options]',
            this.commands.length ? ' [command]' : '',
            this._args.length ? ' ' + args.join(' ') : '',
        ].join('')

        return usage
    }
    optionHelp() {
        const width = this.largestOptionLength()

        return this.options.map(option => pad(option.flags, width) + '  ' + option.description)
            .concat([pad('-h, --help', width) + '  ' + 'output usage information'])
            .join('\n')
    }
    commandHelp() {
        if (!this.commands.length) return ''

        const commands = this.commands.filter(cmd => !cmd._noHelp)
            .map(cmd => {
                const args = cmd._args.map(arg => humanReadableArgName(arg)).join(' ')
                const result = [
                    cmd._name
                    + (cmd._alias ? '|' + cmd._alias : '')
                    + (!!cmd.options.length ? ' [options]' : '')
                    + ' ' + args
                    , cmd._description
                ]

                return result
            })
        const width = commands.reduce((max, cmd) => Math.max(max, cmd[0].length), 0)

        return [
            ''
            , '  Commands:'
            , ''
            , commands.map(function (cmd) {
                var desc = cmd[1] ? '  ' + cmd[1] : '';
                return pad(cmd[0], width) + desc;
            }).join('\n').replace(/^/gm, '    ')
            , ''
        ].join('\n');
    }
    largestOptionLength() {
        return this.options.reduce((max, option) => Math.max(max, option.flags.length), 0)
    }
    addImplicitHelpCommand() {
        this.command('help [cmd]', 'display help for [cmd]')
    }
    optionMissingArg(option, flag) {
        console.error();
        if (flag) {
            console.error("  error: option `%s' argument missing, got `%s'", option.flags, flag);
        } else {
            console.error("  error: option `%s' argument missing", option.flags);
        }
        console.error();
        process.exit(1);
    }
    getOptionByLongFlag(flag) {
        return this.options.find(option => option.is(flag))
    }
    opts() {
        return this.options.reduce((acc, option) => {
            const name = option.name()

            acc[name] = name === 'version' ? this._version : this[name]

            return acc
        }, {})
    }
    optionFor(arg) {
        return this.options.find(option => option.is(arg))
    }
    variadicArgNotLast(name) {
        console.error();
        console.error("  error: variadic arguments must be last `%s'", name);
        console.error();
        process.exit(1);
    }
    executeSubCommand(argv, args, unknown) {
        const file = path.basename(argv[1], '.js') + '-' + args[0]
        const localBin = path.join(path.dirname(argv[1]), file)
        let bin
        let exists
        let isExplicitJS = false
        let proc

        if (args[0] === 'help' && args.length === 1) {
            this.help()
        }

        if (fs.existsSync(localBin + '.js')) {
            exists = true
            isExplicitJS = true
            bin = localBin + '.js'
        }
        else if (fs.existsSync(localBin)) {
            exists = true
            bin = localBin
        }

        if (process.platform !== 'win32') {
            if (isExplicitJS) {
                args.shift()
                args.unshift(bin)
                proc = spawn(argv[0], args, {
                    stdio: 'inherit',
                    customFds: [0, 1, 2],
                })
            }
            else {
                proc = spawn(bin, [], {
                    stdio: 'inherit',
                    customFds: [0, 1, 2],
                })
            }
        }
        else {
            args.unshift(bin);
            proc = spawn(process.execPath, args, { stdio: 'inherit' });
        }


        var signals = ['SIGUSR1', 'SIGUSR2', 'SIGTERM', 'SIGINT', 'SIGHUP'];
        signals.forEach(function (signal) {
            process.on(signal, function () {
                if ((proc.killed === false) && (proc.exitCode === null)) {
                    proc.kill(signal);
                }
            });
        });
        proc.on('close', process.exit.bind(process))
        proc.on('error', (err) => {
            if (err.code == "ENOENT") {
                console.error('\n  %s(1) does not exist, try --help\n', bin);
            }
            else if (err.code === "EACCES") {
                console.error('\n  %s(1) not executable. try chmod or run with root\n', bin);
            }
            process.exit(1)
        })
    }
    help() {
        this.outputHelp()
        process.exit()
    }
    outputHelpIfNecessary(options) {
        for (let i = 0; i < options.length; i++) {
            const option = options[i]
            if (option === '--help' || option === '-h') {
                this.outputHelp()
                process.exit(0)
            }
        }
    }
}

module.exports = new Command()

