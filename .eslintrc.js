module.exports = {
    'env': {
        'browser': true,
        'commonjs': true,
        'es2021': true,
    },
    'extends': 'google',
    'overrides': [
        {
            'env': {
                'node': true,
            },
            'files': [
                '.eslintrc.{js,cjs}',
            ],
            'parserOptions': {
                'sourceType': 'script',
            },
        },
    ],
    'parserOptions': {
        'ecmaVersion': 'latest',
    },
    'rules': {
        'indent': ['error', 4],
        'require-jsdoc': 'off',
        'valid-jsdoc': 'off',
        'max-len': 'off',
        'guard-for-in': 'warn',
    },
};
