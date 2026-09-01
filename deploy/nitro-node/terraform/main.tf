##############################################################################
# OrdoFi Nitro archive node, colocated with Robinhood Chain's sequencer.
#
# Robinhood Chain runs one sequencer and orders transactions first-come-
# first-served. There is no public mempool and no priority auction, so the only
# thing that decides who wins a backrun is who reaches the sequencer first.
# That makes physical distance the product. The sequencer is in AWS us-east-2;
# every millisecond of round trip from anywhere else is a millisecond handed to
# whoever is already there.
#
# The node is also the only way to get:
#   - archive state, so fork tests and historical replay work at all (the
#     public endpoint answers "metadata is not found" a few thousand blocks back)
#   - debug_traceTransaction, absent from the public endpoint, which the
#     watcher needs for honest USD MEV attribution
#   - freedom from the rate limiting and Cloudflare challenges that force
#     everything else in this repo through scripts/fork-proxy.mjs
#
#   terraform init && terraform apply -var="allowed_cidr=$(curl -s ifconfig.me)/32"
##############################################################################

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  description = "Must be us-east-2. The sequencer is there; anywhere else forfeits the race."
  type        = string
  default     = "us-east-2"
}

variable "instance_type" {
  description = "r6i.xlarge is the floor for an archive node: 4 vCPU, 32 GiB, and the network baseline to keep up with 100ms blocks."
  type        = string
  default     = "r6i.xlarge"
}

variable "data_volume_gb" {
  description = "Archive state grows without bound. gp3 so IOPS can be raised without resizing."
  type        = number
  default     = 1000
}

variable "allowed_cidr" {
  description = "Who may reach SSH and the RPC ports. Never 0.0.0.0/0 — an open archive node is someone else's free infrastructure."
  type        = string
}

variable "key_name" {
  description = "Existing EC2 key pair name for SSH."
  type        = string
}

variable "l1_rpc_url" {
  description = "Parent chain RPC the Nitro node validates against."
  type        = string
  sensitive   = true
}

variable "l1_beacon_url" {
  description = "Parent chain beacon endpoint, for blob retrieval."
  type        = string
  sensitive   = true
}

locals {
  name = "ordofi-nitro"
}

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-kernel-6.1-x86_64"]
  }
}

data "aws_vpc" "default" {
  default = true
}

# Placement in a single AZ, recorded explicitly: moving the node between AZs
# changes its latency to the sequencer, which is the one property it exists for.
data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "nitro" {
  name        = "${local.name}-sg"
  description = "OrdoFi Nitro node: SSH and RPC, restricted"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  ingress {
    description = "Nitro HTTP RPC"
    from_port   = 8547
    to_port     = 8547
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  ingress {
    description = "Nitro WebSocket RPC"
    from_port   = 8548
    to_port     = 8548
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-sg" }
}

resource "aws_instance" "nitro" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.instance_type
  key_name               = var.key_name
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.nitro.id]

  root_block_device {
    volume_size = 40
    volume_type = "gp3"
    encrypted   = true
  }

  # Sync is IOPS-bound long before it is CPU-bound, so the data volume is
  # provisioned well above gp3's 3000 baseline.
  ebs_block_device {
    device_name = "/dev/sdf"
    volume_size = var.data_volume_gb
    volume_type = "gp3"
    iops        = 6000
    throughput  = 500
    encrypted   = true
  }

  user_data = templatefile("${path.module}/bootstrap.sh.tftpl", {
    l1_rpc_url    = var.l1_rpc_url
    l1_beacon_url = var.l1_beacon_url
  })

  # Replacing the instance discards a synced archive. Deliberate action only.
  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = local.name }
}

resource "aws_eip" "nitro" {
  instance = aws_instance.nitro.id
  domain   = "vpc"
  tags     = { Name = "${local.name}-eip" }
}

output "public_ip" {
  value = aws_eip.nitro.public_ip
}

output "availability_zone" {
  description = "Record this. Latency to the sequencer is AZ-specific; compare before moving."
  value       = aws_instance.nitro.availability_zone
}

output "rpc_url" {
  value = "http://${aws_eip.nitro.public_ip}:8547"
}

output "next_steps" {
  value = <<-EOT
    1. scp your chain-info.json to /opt/ordofi/chain-info.json
       (published by Robinhood's "Run a full node" documentation)
    2. ssh ec2-user@${aws_eip.nitro.public_ip} 'cd /opt/ordofi && docker compose up -d'
    3. Wait for sync, then confirm archive + debug are actually on:
         node scripts/node-check.mjs http://${aws_eip.nitro.public_ip}:8547
    4. Point everything at it:
         ORDO_RPC_URL=http://${aws_eip.nitro.public_ip}:8547
  EOT
}
