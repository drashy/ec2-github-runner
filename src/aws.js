const {
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  waitUntilInstanceRunning,
  DescribeImagesCommand
} = require("@aws-sdk/client-ec2");
const core = require('@actions/core');
const config = require('./config');

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label) {
  if (config.input.runnerHomeDir) {
    core.info(`Start single runner in ${config.input.runnerHomeDir}..`)
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    return [
      '#!/bin/bash',
      `cd "${config.input.runnerHomeDir}"`,
      'export RUNNER_ALLOW_RUNASROOT=1',
      'export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label} --unattended`,
      './run.sh'
    ];
  } else if (!config.input.numRunners || Number(config.input.numRunners) === 1) {
    core.info("Download and start single runner..")
    return [
      '#!/bin/bash',
      'mkdir actions-runner && cd actions-runner',

      "export ARCH=$(uname -m | sed 's/x86_64/x64/g; s/aarch64/arm64/g')",
      'export RUNNER_VERSION=$(curl --silent "https://api.github.com/repos/actions/runner/releases/latest" | jq -r \'.tag_name[1:]\')',
      'curl -o actions-runner.tar.gz -L https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${ARCH}-{$RUNNER_VERSION}.tar.gz',
      'tar xzf actions-runner.tar.gz',

      'export RUNNER_ALLOW_RUNASROOT=1',
      'export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label} --name $(hostname)-${label} --unattended`,
      './run.sh'
    ];
  }
  core.info(`Download and start ${config.input.numRunners} runners..`)
  const lines = [
    '#!/bin/bash',
    'mkdir actions-runner && cd actions-runner',

    "export ARCH=$(uname -m | sed 's/x86_64/x64/g; s/aarch64/arm64/g')",
    'export RUNNER_VERSION=$(curl --silent "https://api.github.com/repos/actions/runner/releases/latest" | jq -r \'.tag_name[1:]\')',
    'curl -o actions-runner.tar.gz -L https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${ARCH}-{$RUNNER_VERSION}.tar.gz',

    'export RUNNER_ALLOW_RUNASROOT=1',
    'export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1',
  ];
  for (var i = 1; i <= Number(config.input.numRunners) && i <= 32; i++) {
    lines.push(`mkdir ${i} && cd ${i}`);
    lines.push('tar xzf ../actions-runner.tar.gz');
    lines.push(`./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label} --name $(hostname)-${label}-${i} --unattended`);
    lines.push('mkdir _work');
    lines.push('./svc.sh install && ./svc.sh start');
    lines.push('cd ..');
  }
  return lines;
}

async function getImageId(imageNameMatch) {
  const ec2 = new EC2Client({region: process.env.AWS_REGION});

  const describeImagesParams = {
    Owners: ['self'],
    Filters: [{Name: 'name', Values: [imageNameMatch]}],
  };
  
  const command = new DescribeImagesCommand(describeImagesParams);
  const data = await ec2.send(command);
  const sortedImages = data.Images.sort((a, b) => {
    return new Date(b.CreationDate) - new Date(a.CreationDate);
  });
  if (sortedImages.length > 0) {
    const latestImageId = sortedImages[0].ImageId;
    return String(latestImageId);
  } else {
    console.log("No matches")
    throw `no matches for ${imageNameMatch}`;
  }
}

async function startEc2Instance(label, githubRegistrationToken) {
  const userData = buildUserDataScript(githubRegistrationToken, label);

  const params = {
    ImageId: config.input.ec2ImageAmiName ? await getImageId(config.input.ec2ImageAmiName) : config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    MinCount: config.input.numInstances || 1,
    MaxCount: config.input.numInstances || 1,
    UserData: Buffer.from(userData.join('\n')).toString('base64'),
    SubnetId: config.input.subnetId,
    SecurityGroupIds: [config.input.securityGroupId],
    IamInstanceProfile: { Name: config.input.iamRoleName },
    TagSpecifications: config.tagSpecifications,
  };

  // add spot params if we are requesting a spot instance
  if (config.input.useSpotInstances) {
    params["InstanceMarketOptions"] = {
      MarketType: 'spot',
      SpotOptions: {
        SpotInstanceType: 'one-time',
      },
    }
  }

  const ec2 = new EC2Client({region: process.env.AWS_REGION});

  const runInstancesCommand = new RunInstancesCommand(params);

  console.log("beforesend")
  await ec2.send(runInstancesCommand, (err, data) => {
    if (err) {
      console.log(err, err.stack);
      core.error(`AWS EC2 instance failed to start - error: ${err}`)
      throw err;
    } else {
      const ec2InstanceIds = data.Instances.map(x => x.InstanceId); //[0].InstanceId; pass all instances instead of just first id
      core.info(`AWS EC2 instance(s) ${ec2InstanceIds} is started`);
      return ec2InstanceIds;
    }
  });
  console.log("aftersend")
}

async function terminateEc2Instance() {
  const ec2 = new EC2Client({region: process.env.AWS_REGION});

  const params = {
    InstanceIds: JSON.parse(config.input.ec2InstanceId),
  };

  const command = new TerminateInstancesCommand(params);
  ec2.send(command, (err, data) => {
    if (err) {
      core.error(`AWS EC2 instance ${data.InstanceIds} termination error: ${err}`);
      throw err;
    } else {
      core.info(`AWS EC2 instance ${data.InstanceIds} is terminated`);
      return;
    }
  });
}

async function waitForInstanceRunning(ec2InstanceId) {
  core.info(`waitForInstanceRunning: ${ec2InstanceId}`)
  const ec2 = new EC2Client({region: process.env.AWS_REGION});

  try {
    await waitUntilInstanceRunning({
      client: ec2,
      maxWaitTime: 120
    }, {InstanceIds: ec2InstanceId});
    core.info(`AWS EC2 instance(s) ${ec2InstanceId} is up and running`);
    return ec2InstanceId;
  } catch (error) {
    core.error(`AWS EC2 instance(s) ${ec2InstanceId} initialization error: ${error}`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
};