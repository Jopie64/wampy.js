process.env.CHROME_BIN = require('puppeteer').executablePath();

module.exports = function (config) {

    config.set({
        basePath: '',
        frameworks: ['mocha', 'karma-typescript'],
        exclude: [],
        files: [{
            pattern: 'test/!(wampy-crossbar)-test.js',
            watched: false
        }],
        preprocessors: {
            'src/*.ts': ['karma-typescript'],
            'src/*.js': ['karma-typescript'],
            'test/*-test.js': ['karma-typescript']
        },

        karmaTypescriptConfig: {
            tsconfig: "./tsconfig.json",
            include: ['src/*.ts', 'test/*-test.js']
        },

        coverageReporter: {
            dir: 'coverage/',
            reporters: [
                {type: 'text-summary'},
                {type: 'json'},
                {type: 'html'}
            ]
        },
        webpackServer: {noInfo: true},
        reporters: ['mocha', 'coverage', 'karma-typescript'],
        port: 9876,
        colors: true,
        browserNoActivityTimeout: 60000,
        logLevel: config.LOG_INFO,
        autoWatch: false,
        browsers: ['HeadlessChrome'],
        customLaunchers:{
            HeadlessChrome:{
                base: 'ChromeHeadless',
                flags: [
                    '--no-sandbox',
                    '--disable-web-security',
                    '--disable-gpu'
                ]
            }
        },
        singleRun: true
    });
};
