const GitHubApi = require("github");
const Promise = require('bluebird');
const inquirer = require('inquirer');
const fs = require('fs');
const predefinedLabels = require('./config/labels');

const github = new GitHubApi({
    debug: false,
    protocol: "https",
    host: "api.github.com",
    pathPrefix: "",
    headers: {
        "user-agent": "My-Cool-GitHub-App"
    },
    Promise: Promise,
    followRedirects: false,
    timeout: 5000
});

Promise.promisifyAll(github.authorization);
Promise.promisifyAll(github.issues);
Promise.promisifyAll(github.repos);

function getRepositories(user) {
    return github.repos.getForUser({
        user: user,
        type: 'owner'
    });
}

function createLabel(repository, owner, name, color) {
    return github.issues.createLabel({
        owner: owner,
        repo: repository.name,
        name: name,
        color: color
    }).then(function() {
      return console.log("Label: '" + name + "' created in repo '" + repository.name + "'");
    }).catch(function(err) {
      if (err && err.code === 422) {
          console.log("Label: '" + name + "' already exists in repo '" + repository.name + "'");
      } else {
          console.log("Failed to create label in '" + repository.name + "'");
      }
      
      // Propagate error to the tests
      throw err;
    });
}

function getIssues(repository, owner) {
	return github.issues.getForRepo({
		owner: owner,
		repo: repository.name
	}).each(issue => issue.repo = repository);
}

function getLabels(repository, owner) {
    return github.issues.getLabels({
        owner: owner,
        repo: repository.name
    }).map(label => ({name: label.name, color: label.color}));
}

function addLabels(repository, issue, owner, labels) {
	return github.issues.addLabels({
		owner: owner,
		repo: repository.name,
		number: issue.number,
		body: labels
	});
}

function loginBasic() {
    return inquirer.prompt([
        {
            type: 'input',
            name: 'username',
            message: 'Enter your GitHub username:'
        },
        {
            type: 'password',
            name: 'password',
            message: 'Enter your GitHub password:'
        }
    ]).then(login => {
        github.authenticate({
            type: "basic",
            username: login.username,
            password: login.password
        });
    });
}

function loginToken() {
    return new Promise(function (resolve, reject) {
        fs.readFile('.access-token', function (error, token) {
            if (error) {
                reject(error);
            } else {
                resolve(github.authenticate({type: "token", token: token}));
            }
        });
    });
}

function createToken() {
    return inquirer.prompt([
        {
            type: 'confirm',
            name: 'confirmToken',
            message: 'Do you wish to create an access token to GitHub?'
        }
    ]).then(answer => {
        if (answer.confirmToken) {
            return github.authorization.create({
                scopes: ['repo'],
                note: 'github-manager-cli'
            }).then(result => fs.writeFile('.access-token', result.token));
        }
    });
}

Promise.coroutine(function*() {
    yield loginToken().catch(error => loginBasic().then(createToken));

    const {owner} = yield inquirer.prompt([
        {
            type: 'input',
            name: 'owner',
            message: 'Enter the owner of the repositories:'
        }
    ]);

    const repositories = yield getRepositories(owner);

    const {confirmLabelCopy} = yield inquirer.prompt([
        {
            type: 'confirm',
            name: 'confirmLabelCopy',
            message: 'Do you want to copy labels from one repo to another?'
        }
    ]);

    if (confirmLabelCopy) {

        const {copyFromRepository} = yield inquirer.prompt([
            {
                type: 'list',
                name: 'copyFromRepository',
                choices: repositories.map(repo => ({name: repo.name, value: repo})),
                message: 'Please select the repository to copy FROM:'
            }
        ]);

        if (copyFromRepository.length == 0) {
            return;
        }

        const labels = yield Promise.all(getLabels(copyFromRepository, owner));

        const {copyToRepositories} = yield inquirer.prompt([
            {
                type: 'checkbox',
                name: 'copyToRepositories',
                choices: repositories.map(repo => ({name: repo.name, value: repo})),
                message: 'Please select the repositories to copy TO:'
            }
        ]);

        if (copyToRepositories.length == 0) {
            return;
        }

        yield Promise.resolve(labels)
            .each(label => copyToRepositories.map(repo => createLabel(repo, owner, label.name, label.color)))

        return
    }

    const {selectedRepositories} = yield inquirer.prompt([
        {
            type: 'checkbox',
            name: 'selectedRepositories',
            choices: repositories.map(repo => ({name: repo.name, value: repo})),
            message: 'Please select the repositories where you want to add labels to issues:'
        }
    ]);

    if (selectedRepositories.length == 0) {
        return;
    }

    const {addPredefinedLabels} = yield inquirer.prompt([
        {
            type: 'confirm',
            name: 'addPredefinedLabels',
            message: 'Do you want to add your predefined labels to the selected Repositories?'
        }
    ]);

    if (addPredefinedLabels) {
        yield Promise.resolve(predefinedLabels)
            .each(label => selectedRepositories.map(repo => createLabel(repo, owner, label.name, label.color)))
        return
    }

    const issues = yield Promise.all(selectedRepositories.map(repo => getIssues(repo, owner)))
        .reduce((all, current) => all.concat(current));

    const {selectedIssues} = yield inquirer.prompt([
        {
            type: 'checkbox',
            name: 'selectedIssues',
            choices: issues.map(issue => ({name: issue.title, value: issue})),
            message: 'Please select the issues:'
        }
    ]);

    if (selectedIssues.length === 0) {
        return;
    }

    const label = yield inquirer.prompt([
        {
            type: 'input',
            name: 'name',
            message: 'Please enter the label name:'
        },
        {
            type: 'input',
            name: 'color',
            message: 'Please select the color:',
            validate: color => /^[0-9a-fA-F]{6}$/.test(color) || 'Input a color as a 6 digit hex code.'
        }
    ]);

    yield Promise.resolve(selectedRepositories)
        .each(repo => createLabel(repo, owner, label.name, label.color))
        .then(() => selectedIssues)
        .each(issue => addLabels(issue.repo, issue, owner, [label.name]))
})().catch(e => displayError(e));

function displayError(error) {
    if (!error) {
        console.log('Unknown error :/');
        return 'Unknown error :/';
    }

    let errorMessage = error;
    if (error.message && typeof error.message == 'string') {
        let json;
        try {
          json = JSON.parse(error.message);
        } catch(err) { /* Failed to parse JSON */ }
        
        if (json && json.message) {
            errorMessage = json.message;
        } else {
            errorMessage = error.message;
        }
    }

    console.log(`Error: ${errorMessage}`);
    return `Error: ${errorMessage}`;
}

// Export functions for testing purposes
module.exports = { displayError, addLabels, getLabels, getIssues, createLabel, getRepositories };