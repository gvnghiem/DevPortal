/* terraform-ui.js — Terraform Playground UI for DevPortal.
 * Drives TFSim (terraform-sim.js): command bar, animated infrastructure diagram, console log, registry tab, examples.
 */
(function () {
"use strict";
const S = window.TFSim;
const D = s => s.replace(/@\{/g, "${");

/* ───────────────────────── examples ───────────────────────── */
const TF_EXAMPLES = {
"Start here: VPC + EC2": D(`# Press ▶ Run (init → plan → apply) or use the command bar above.
# Then edit something and Apply again — try changing the instance_type (in-place update)
# or the VPC cidr_block (forces replacement of the whole chain!).

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = "us-east-1"
}

variable "env" {
  type    = string
  default = "dev"
}

locals {
  name = "demo-@{var.env}"
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags = { Name = local.name }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
}

resource "aws_subnet" "public" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
  tags = { Name = "@{local.name}-public" }
}

resource "aws_security_group" "web" {
  name   = "@{local.name}-web"
  vpc_id = aws_vpc.main.id
}

resource "aws_instance" "web" {
  ami                    = "ami-0c55b159cbfafe1f0"
  instance_type          = "t3.micro"
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.web.id]
  tags = { Name = "@{local.name}-web" }
}

output "web_public_ip" {
  value = aws_instance.web.public_ip
}
`),
"Three-tier web app": D(`# Public subnets x2, an ALB, a target group, and an EC2 fleet built with count.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" { region = "us-east-1" }

variable "web_count" {
  type    = number
  default = 3
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
}

resource "aws_vpc" "main" {
  cidr_block = "10.20.0.0/16"
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
}

resource "aws_subnet" "public" {
  count      = 2
  vpc_id     = aws_vpc.main.id
  cidr_block = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
}

resource "aws_route" "internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.igw.id
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "alb" {
  name   = "alb-sg"
  vpc_id = aws_vpc.main.id
}

resource "aws_lb" "web" {
  name            = "web-alb"
  subnets         = aws_subnet.public[*].id
  security_groups = [aws_security_group.alb.id]
}

resource "aws_lb_target_group" "web" {
  name     = "web-tg"
  port     = 80
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.web.arn
  port              = 80
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_instance" "web" {
  count         = var.web_count
  ami           = data.aws_ami.ubuntu.id
  instance_type = "t3.small"
  subnet_id     = aws_subnet.public[count.index % 2].id
}

resource "aws_lb_target_group_attachment" "web" {
  count            = var.web_count
  target_group_arn = aws_lb_target_group.web.arn
  target_id        = aws_instance.web[count.index].id
}

output "alb_dns" {
  value = aws_lb.web.dns_name
}
`),
"Serverless API": D(`# Lambda behind API Gateway with a DynamoDB table and IAM role.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" { region = "us-east-1" }

resource "aws_dynamodb_table" "items" {
  name         = "items"
  hash_key     = "id"
  billing_mode = "PAY_PER_REQUEST"
}

resource "aws_iam_role" "lambda" {
  name = "items-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_policy" "table_access" {
  name = "items-table-access"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem"]
      Resource = aws_dynamodb_table.items.arn
    }]
  })
}

resource "aws_iam_role_policy_attachment" "attach" {
  role       = aws_iam_role.lambda.name
  policy_arn = aws_iam_policy.table_access.arn
}

resource "aws_cloudwatch_log_group" "fn" {
  name              = "/aws/lambda/items"
  retention_in_days = 14
}

resource "aws_lambda_function" "items" {
  function_name = "items"
  role          = aws_iam_role.lambda.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  environment {
    variables = { TABLE = aws_dynamodb_table.items.name }
  }
  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy_attachment.attach]
}

resource "aws_apigatewayv2_api" "http" {
  name          = "items-api"
  protocol_type = "HTTP"
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.items.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "@{aws_apigatewayv2_api.http.execution_arn}/*/*"
}

output "api_url" {
  value = aws_apigatewayv2_api.http.api_endpoint
}
`),
"S3 data lake (for_each)": D(`# for_each builds one bucket per zone; each gets versioning + public-access block.
terraform {
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "aws" { region = "us-east-1" }

variable "zones" {
  type    = list(string)
  default = ["raw", "curated", "analytics"]
}

resource "random_pet" "suffix" {
  length = 2
}

resource "aws_s3_bucket" "zone" {
  for_each = toset(var.zones)
  bucket   = "lake-@{each.key}-@{random_pet.suffix.id}"
}

resource "aws_s3_bucket_versioning" "zone" {
  for_each = aws_s3_bucket.zone
  bucket   = each.value.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "zone" {
  for_each                = aws_s3_bucket.zone
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

output "buckets" {
  value = { for k, b in aws_s3_bucket.zone : k => b.arn }
}
`),
"RDS + private subnets": D(`# Private database tier: subnets, subnet group, security group, RDS instance (the slow one).
terraform {
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "aws" { region = "us-east-1" }

resource "aws_vpc" "db" {
  cidr_block = "10.30.0.0/16"
}

resource "aws_subnet" "private" {
  count      = 2
  vpc_id     = aws_vpc.db.id
  cidr_block = cidrsubnet(aws_vpc.db.cidr_block, 8, count.index + 10)
}

resource "aws_db_subnet_group" "main" {
  name       = "db-private"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_security_group" "db" {
  name   = "db-sg"
  vpc_id = aws_vpc.db.id
}

resource "random_password" "db" {
  length = 20
}

resource "aws_db_instance" "main" {
  identifier             = "orders-db"
  engine                 = "postgres"
  instance_class         = "db.t3.medium"
  allocated_storage      = 50
  username               = "app"
  password               = random_password.db.result
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
}

output "db_endpoint" {
  value = aws_db_instance.main.endpoint
}
`),
"Azure: RG + VNet + VM": D(`terraform {
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
  }
}

provider "azurerm" {
  features {}
}

resource "azurerm_resource_group" "rg" {
  name     = "rg-demo"
  location = "eastus"
}

resource "azurerm_virtual_network" "vnet" {
  name                = "vnet-demo"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  address_space       = ["10.40.0.0/16"]
}

resource "azurerm_subnet" "app" {
  name                 = "app"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.40.1.0/24"]
}

resource "azurerm_public_ip" "vm" {
  name                = "pip-vm"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  allocation_method   = "Static"
}

resource "azurerm_network_interface" "vm" {
  name                = "nic-vm"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
}

resource "azurerm_linux_virtual_machine" "vm" {
  name                = "vm-demo"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  size                = "Standard_B2s"
  depends_on          = [azurerm_subnet.app, azurerm_public_ip.vm, azurerm_network_interface.vm]
}

output "vm_ip" {
  value = azurerm_linux_virtual_machine.vm.public_ip_address
}
`),
"GCP: network + VM + bucket": D(`terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}

provider "google" {
  project = "demo-project-123"
  region  = "us-central1"
}

resource "google_compute_network" "vpc" {
  name = "demo-vpc"
}

resource "google_compute_subnetwork" "sub" {
  name          = "demo-sub"
  ip_cidr_range = "10.50.0.0/24"
  network       = google_compute_network.vpc.id
}

resource "google_compute_firewall" "ssh" {
  name    = "allow-ssh"
  network = google_compute_network.vpc.name
}

resource "google_compute_instance" "vm" {
  name         = "demo-vm"
  machine_type = "e2-medium"
  zone         = "us-central1-a"
  depends_on   = [google_compute_subnetwork.sub, google_compute_firewall.ssh]
}

resource "google_storage_bucket" "assets" {
  name     = "demo-assets-123456"
  location = "US"
}
`),
"Failure: apply-time error": D(`# The plan succeeds, but AWS rejects the bucket name at apply time — just like real life.
# Watch the failed node turn red and everything downstream get skipped.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" { region = "us-east-1" }

resource "aws_s3_bucket" "logs" {
  bucket = "logs"
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket = aws_s3_bucket.logs.id
}

resource "aws_vpc" "ok" {
  cidr_block = "10.9.0.0/16"
}
`),
"Failure: config errors": D(`# Run Validate or Plan to see Terraform-style diagnostics for each mistake.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" { region = "us-east-1" }

resource "aws_vpc" "main" {
  cidr_block = var.cidr
}

resource "aws_subnet" "a" {
  vpc_id = aws_vpc.mian.id
}

resource "aws_instance" "web" {
  ami = "ami-123"
}

output "id" {
  value = upper(aws_vpc.main.id, "extra")
}
`)
};
const TF_GROUPS = {
  "AWS": ["Start here: VPC + EC2", "Three-tier web app", "Serverless API", "S3 data lake (for_each)", "RDS + private subnets"],
  "Other clouds": ["Azure: RG + VNet + VM", "GCP: network + VM + bucket"],
  "Failures": ["Failure: apply-time error", "Failure: config errors"]
};
window.TF_EXAMPLES = TF_EXAMPLES; window.TF_GROUPS = TF_GROUPS;

/* ───────────────────────── styles ───────────────────────── */
const css = document.createElement("style");
css.textContent = `
#tfView{display:none;flex-direction:column;background:var(--pbg);color:var(--text);font-size:12.5px;overflow:hidden}
#tfView.on{display:flex}
.tfbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--pbg) 94%,var(--text))}
.tfbar button{padding:4px 10px;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace}
.tfbar button.go{background:var(--accent2);color:var(--accent-text);font-weight:600}
.tfbar button:disabled{opacity:.45;cursor:default}
.tfbar select{font-size:12px;padding:3px 6px}
.tfbar .sp{flex:1}
.tfchip{padding:2px 10px;border-radius:99px;border:1px solid var(--line);font-size:11px;color:var(--muted);white-space:nowrap}
.tfchip[data-s=busy]{color:var(--accent);border-color:var(--accent)}
.tfchip[data-s=ok]{color:var(--ok);border-color:var(--ok)}
.tfchip[data-s=err]{color:var(--err);border-color:var(--err)}
#tfCmd{padding:4px 12px;font:12px ui-monospace,Menlo,Consolas,monospace;background:var(--editor);color:var(--muted);border-bottom:1px solid var(--line)}
#tfCmd span{color:var(--accent);font-weight:600}
#tfStage{position:relative;flex:1;min-height:0}
#tfSvg{position:absolute;inset:0;width:100%;height:100%}
#tfEmpty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted);text-align:center;padding:20px;line-height:1.6}
#tfBanner{position:absolute;left:10px;right:10px;top:8px;padding:6px 10px;border:1px solid var(--err);color:var(--err);background:color-mix(in srgb,var(--pbg) 88%,var(--err));border-radius:8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;display:none;z-index:2}
#tfLegend{position:absolute;right:10px;top:8px;display:flex;gap:10px;font-size:11px;color:var(--muted);z-index:1;background:color-mix(in srgb,var(--pbg) 80%,transparent);padding:2px 8px;border-radius:8px}
#tfLegend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:4px;vertical-align:-1px}
#tfDetail{position:absolute;left:10px;bottom:8px;max-width:46%;max-height:46%;overflow:auto;border:1px solid var(--line);background:color-mix(in srgb,var(--pbg) 94%,var(--text));border-radius:8px;padding:8px 10px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;white-space:pre-wrap;display:none;z-index:2}
#tfProg{display:flex;gap:14px;align-items:center;padding:5px 10px;border-top:1px solid var(--line);color:var(--muted);font-size:11.5px;font-family:ui-monospace,Menlo,Consolas,monospace}
#tfProg .bar{flex:1;height:6px;border-radius:99px;background:var(--line);overflow:hidden;min-width:60px}
#tfProg .bar i{display:block;height:100%;width:0;background:var(--ok);transition:width .25s}
#tfLog{height:104px;overflow:auto;border-top:1px solid var(--line);background:var(--editor);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;padding:4px 10px;white-space:pre-wrap}
#tfLog div.ok{color:var(--ok)}#tfLog div.err{color:var(--err)}#tfLog div.warn{color:var(--warn)}#tfLog div.info{color:var(--accent)}
.ln.ok{color:var(--ok)}
.ln.error-cont{color:var(--err)}
.ln.tf{padding:0 14px;border-bottom:0;line-height:1.5}
/* diagram */
.tfn{cursor:pointer;transform-box:fill-box;transform-origin:center;animation:tfpop .45s cubic-bezier(.2,.9,.3,1.2) both}
.tfn .box{fill:color-mix(in srgb,var(--pbg) 90%,var(--text));stroke:var(--line);stroke-width:1.4}
.tfn .nm{fill:var(--text);font:600 12px system-ui,sans-serif}
.tfn .ty{fill:var(--muted);font:10.5px ui-monospace,Menlo,Consolas,monospace}
.tfn .ic{font-size:19px}
.tfn .bd{font:700 12px system-ui,sans-serif;fill:#fff;text-anchor:middle;dominant-baseline:central}
.tfn .bdc{fill:var(--muted)}
.tfn .spin{fill:none;stroke:var(--accent);stroke-width:2.4;stroke-dasharray:18 22;opacity:0;rx:12}
.tfn[data-st=config] .box,.tfn[data-st=orphan] .box{stroke-dasharray:5 4}
.tfn[data-st=exists] .box,.tfn[data-st=noop] .box{stroke:var(--ok);opacity:.95}
.tfn[data-st=p-create] .box{stroke:var(--ok);stroke-dasharray:6 4;opacity:.8}
.tfn[data-st=p-update] .box,.tfn[data-st=p-replace] .box{stroke:var(--warn);stroke-dasharray:6 4}
.tfn[data-st=p-delete] .box{stroke:var(--err);stroke-dasharray:6 4}
.tfn[data-st=read] .box{stroke:var(--accent2);stroke-dasharray:2 3}
.tfn[data-st=read] .nm{font-style:italic}
.tfn[data-st=p-create] .bdc{fill:var(--ok)}.tfn[data-st=p-update] .bdc,.tfn[data-st=p-replace] .bdc{fill:var(--warn)}.tfn[data-st=p-delete] .bdc{fill:var(--err)}
.tfn[data-st=work] .box{stroke:var(--accent);stroke-width:2.2;animation:tfglow 1s ease-in-out infinite alternate}
.tfn[data-st=work][data-k=update] .box{stroke:var(--warn)}.tfn[data-st=work][data-k=delete] .box{stroke:var(--err)}
.tfn[data-st=work] .spin{opacity:1;animation:tfspin 1.1s linear infinite}
.tfn[data-st=work][data-k=update] .spin{stroke:var(--warn)}.tfn[data-st=work][data-k=delete] .spin{stroke:var(--err)}
.tfn[data-st=work] .bdc{fill:var(--accent)}
.tfn[data-st=done] .box{stroke:var(--ok);stroke-width:2;animation:tfflash .7s}
.tfn[data-st=done] .bdc{fill:var(--ok)}
.tfn[data-st=gone]{opacity:.38}.tfn[data-st=gone] .box{stroke:var(--err)}.tfn[data-st=gone] .nm{text-decoration:line-through}.tfn[data-st=gone] .bdc{fill:var(--err)}
.tfn[data-st=fail] .box{stroke:var(--err);stroke-width:2.4;animation:tfshake .45s}
.tfn[data-st=fail] .bdc{fill:var(--err)}
.tfn[data-st=skip]{opacity:.45}.tfn[data-st=skip] .box{stroke-dasharray:3 5}
.tfe{fill:none;stroke:var(--muted);stroke-width:1.4;opacity:.5;stroke-dasharray:1;stroke-dashoffset:1;animation:tfdraw .7s ease-out forwards}
.tfe.lit{stroke:var(--ok);opacity:.85}
.tff{fill:none;stroke:var(--accent);stroke-width:2.6;stroke-dasharray:5 9;opacity:0}
.tff.on{opacity:1;animation:tfflow .6s linear infinite}
.tfcol{fill:var(--muted);font:600 10px system-ui,sans-serif;letter-spacing:.08em;text-anchor:middle;opacity:.7}
@keyframes tfpop{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:scale(1)}}
@keyframes tfspin{to{stroke-dashoffset:-80}}
@keyframes tfglow{from{filter:drop-shadow(0 0 1px var(--accent))}to{filter:drop-shadow(0 0 7px var(--accent))}}
@keyframes tfflash{0%{filter:drop-shadow(0 0 10px var(--ok))}100%{filter:none}}
@keyframes tfshake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
@keyframes tfdraw{to{stroke-dashoffset:0}}
@keyframes tfflow{to{stroke-dashoffset:-28}}
#registry{display:none;flex-direction:column;background:var(--pbg)}
#registry.on{display:flex}
.rgbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--line);font-size:12px}
.rgbar b{margin-right:6px}
.rgbar button,.rgbar a{padding:3px 9px;font-size:12px;border:1px solid var(--line);border-radius:7px;background:transparent;color:var(--text);text-decoration:none;cursor:pointer}
.rgbar a{margin-left:auto}
#registry iframe{flex:1;width:100%;border:0;background:#fff}
.rgnote{padding:4px 10px;border-top:1px solid var(--line);font-size:11px;color:var(--muted)}
@media (prefers-reduced-motion:reduce){.tfn,.tfe{animation:none!important;stroke-dashoffset:0}.tfn .spin,.tff.on{animation:none!important}}
`;
document.head.appendChild(css);

/* ───────────────────────── controller ───────────────────────── */
let api = null, view = null, els = {}, cfgCache = null;
let state = loadState(), initialized = false, busy = false, token = 0, paused = false, speed = 8;
let graph = null, nodeEls = {}, edgeEls = {}, nodeInfo = {};
let active = false, draftTimer = null;

function loadState() { try { const s = JSON.parse(localStorage.getItem("devportal.tf.state") || "null"); if (s && s.resources) return s; } catch (e) {} return S.newState(); }
function saveState() { try { localStorage.setItem("devportal.tf.state", JSON.stringify(state)); } catch (e) {} }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function mount(a) {
  api = a;
  const wrap = document.getElementById("frameWrap");
  view = document.createElement("div"); view.id = "tfView";
  view.innerHTML =
    '<div class="tfbar">' +
    '<button data-c="init" title="terraform init">init</button>' +
    '<button data-c="validate" title="terraform validate">validate</button>' +
    '<button data-c="plan" title="terraform plan">plan</button>' +
    '<button data-c="apply" class="go" title="terraform apply -auto-approve">apply</button>' +
    '<button data-c="destroy" title="terraform destroy -auto-approve">destroy</button>' +
    '<button data-c="state" title="terraform state list">state</button>' +
    '<button data-c="output" title="terraform output">output</button>' +
    '<span class="sp"></span>' +
    '<button data-c="pause" disabled title="Pause / resume the simulation">⏸ pause</button>' +
    '<label class="tfchip" style="border:0">speed <select id="tfSpeed"><option value="2">2×</option><option value="4">4×</option><option value="8" selected>8×</option><option value="20">20×</option><option value="100">100×</option><option value="0">instant</option></select></label>' +
    '<button data-c="reset" title="Forget all state (like deleting terraform.tfstate)">reset state</button>' +
    '<span class="tfchip" id="tfStatus" data-s="idle">idle</span></div>' +
    '<div id="tfCmd">$ terraform <span>(ready)</span></div>' +
    '' +
    '<div id="tfStage"><div id="tfEmpty"><div>Edit the Terraform on the left — resources appear here as a diagram.<br>Press <b>▶ Run</b> to init, plan and apply.</div></div>' +
    '<svg id="tfSvg" xmlns="http://www.w3.org/2000/svg"><defs><marker id="tfarr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--muted)"/></marker></defs><g id="tfG"></g></svg>' +
    '<div id="tfBanner"></div><div id="tfLegend"></div><div id="tfDetail"></div></div>' +
    '<div id="tfProg"><span id="tfCount">0 / 0</span><div class="bar"><i id="tfBar"></i></div><span id="tfClock">0:00 sim</span></div>' +
    '<div id="tfLog"></div>';
  wrap.appendChild(view);
  ["tfSvg", "tfG", "tfEmpty", "tfBanner", "tfLegend", "tfDetail", "tfCount", "tfBar", "tfClock", "tfLog", "tfCmd", "tfStatus", "tfSpeed"].forEach(i => els[i] = document.getElementById(i));
  els.tfLegend.innerHTML = [["var(--ok)", "create"], ["var(--warn)", "update/replace"], ["var(--err)", "destroy"], ["var(--accent)", "in progress"]].map(x => '<span><i style="background:' + x[0] + '"></i>' + x[1] + '</span>').join("");
  view.querySelectorAll(".tfbar button[data-c]").forEach(b => b.onclick = () => command(b.dataset.c));
  els.tfSpeed.onchange = () => { speed = +els.tfSpeed.value; };
  els.tfSvg.addEventListener("click", e => { if (!e.target.closest(".tfn")) els.tfDetail.style.display = "none"; });

}

function status(text, s) { els.tfStatus.textContent = text; els.tfStatus.dataset.s = s || "idle"; }
function setBusy(b) {
  busy = b;
  view.querySelectorAll(".tfbar button[data-c]").forEach(x => { if (x.dataset.c === "pause") x.disabled = !b; else if (x.dataset.c !== "reset") x.disabled = b; });
  if (!b) { paused = false; view.querySelector('[data-c="pause"]').textContent = "⏸ pause"; }
}
function lvl(line) {
  const t = line.trim();
  if (/^(\+|\-\/\+|~|-) /.test(t) && !/^- (Finding|Installing|Installed)/.test(t)) return t[0] === "+" ? "ok" : t[0] === "-" && t.slice(0, 3) !== "-/+" ? "err" : "warn";
  if (/Creation complete|Modifications complete|Destruction complete|Read complete|Apply complete|Destroy complete|Success!|successfully|Installed/.test(t)) return "ok";
  if (/^Plan:/.test(t)) return "info";
  if (/^│ Error|^Error:/.test(t)) return "err";
  if (/^│ Warning/.test(t)) return "warn";
  if (/Still (creating|modifying|destroying)|Refreshing state/.test(t)) return "sys";
  return "log";
}
function out(lines, forced) {
  (Array.isArray(lines) ? lines : [lines]).forEach(l => {
    const lv = forced || lvl(l);
    api.addLine((lv === "err" ? (/Error:/.test(l) ? "error" : "error-cont") : lv) + " tf", l === "" ? " " : l);
    const d = document.createElement("div"); d.className = lv === "sys" ? "" : lv; d.style.opacity = lv === "sys" ? ".6" : ""; d.textContent = l === "" ? " " : l;
    els.tfLog.appendChild(d);
  });
  while (els.tfLog.childElementCount > 400) els.tfLog.firstChild.remove();
  els.tfLog.scrollTop = els.tfLog.scrollHeight;
}
function cmdEcho(c) { els.tfCmd.innerHTML = "$ terraform <span>" + c.replace(/</g, "&lt;") + "</span>"; out("$ terraform " + c, "info"); }

/* config */
function getCfg(announce) {
  const cfg = S.loadConfig(api.getCode());
  cfgCache = cfg;
  if (!cfg.ok) {
    if (announce) {
      cfg.errors.forEach(e => out(S.formatDiagnostic(e, cfg), "err"));
      out(["", "Error: " + cfg.errors.length + " error" + (cfg.errors.length > 1 ? "s" : "") + " found in the configuration."], "err");
      api.showTab("preview");
      status("config error", "err"); draw({ nodes: [], edges: [] });
    }
    banner(cfg);
    return null;
  }
  banner(null);
  return cfg;
}
function banner(cfg) {
  if (!cfg) { els.tfBanner.style.display = "none"; return; }
  const e = cfg.errors[0];
  els.tfBanner.textContent = "Line " + (e.line || "?") + ": " + e.summary + (cfg.errors.length > 1 ? "  (+" + (cfg.errors.length - 1) + " more)" : "");
  els.tfBanner.style.display = "block";
}

/* ───────────── diagram ───────────── */
const NW = 176, NH = 56, GX = 78, GY = 20, PAD = 26;
function layout(g) {
  const byId = {}; g.nodes.forEach(n => byId[n.id] = n);
  const par = {}; g.edges.forEach(e => (par[e.to] = par[e.to] || []).push(e.from));
  const memo = {}, visiting = {};
  const depth = id => { if (id in memo) return memo[id]; if (visiting[id]) return 0; visiting[id] = 1; let d = 0; (par[id] || []).forEach(p => { if (byId[p]) d = Math.max(d, depth(p) + 1); }); visiting[id] = 0; return (memo[id] = d); };
  const layers = [];
  g.nodes.forEach(n => { const d = depth(n.id); (layers[d] = layers[d] || []).push(n); });
  for (let i = 0; i < layers.length; i++) layers[i] = layers[i] || [];
  const idx = {};
  layers.forEach((L, li) => {
    if (li > 0) L.sort((a, b) => bary(a, par, idx) - bary(b, par, idx));
    L.forEach((n, i) => (idx[n.id] = i));
  });
  const maxN = Math.max(1, ...layers.map(l => l.length)), H = maxN * NH + (maxN - 1) * GY;
  layers.forEach((L, li) => {
    const h = L.length * NH + (L.length - 1) * GY, off = (H - h) / 2;
    L.forEach((n, i) => { n.x = PAD + li * (NW + GX); n.y = PAD + 18 + off + i * (NH + GY); n.layer = li; });
  });
  return { w: PAD * 2 + layers.length * NW + (layers.length - 1) * GX, h: PAD * 2 + 18 + H, layers: layers.length };
}
function bary(n, par, idx) { const p = par[n.id] || []; if (!p.length) return 0; return p.reduce((s, x) => s + (idx[x] || 0), 0) / p.length; }
const NS = "http://www.w3.org/2000/svg";
function el(tag, attrs, text) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text !== undefined) e.textContent = text; return e; }
const ACT_ST = { create: "p-create", update: "p-update", delete: "p-delete", replace: "p-replace", noop: "noop", read: "read", exists: "exists", config: "config", orphan: "orphan" };
const BADGE = { "p-create": "+", "p-update": "~", "p-delete": "−", "p-replace": "±", noop: "✓", read: "R", exists: "✓", config: "", orphan: "?", work: "…", done: "✓", gone: "−", fail: "✕", skip: "·" };

function draw(g) {
  graph = g; nodeEls = {}; edgeEls = {}; nodeInfo = {};
  const G = els.tfG; G.innerHTML = "";
  els.tfDetail.style.display = "none";
  if (!g.nodes.length) { els.tfEmpty.style.display = "flex"; els.tfSvg.style.display = "none"; return; }
  els.tfEmpty.style.display = "none"; els.tfSvg.style.display = "";
  const dim = layout(g);
  els.tfSvg.setAttribute("viewBox", "0 0 " + Math.max(dim.w, 520) + " " + Math.max(dim.h, 200));
  els.tfSvg.setAttribute("preserveAspectRatio", dim.w < 520 ? "xMinYMin meet" : "xMidYMid meet");
  const byId = {}; g.nodes.forEach(n => byId[n.id] = n);
  const eg = el("g", {}), ng = el("g", {}); G.appendChild(eg); G.appendChild(ng);
  g.edges.forEach((e, i) => {
    const a = byId[e.from], b = byId[e.to]; if (!a || !b) return;
    const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, dx = Math.max(30, (x2 - x1) / 2);
    const d = "M" + x1 + " " + y1 + " C" + (x1 + dx) + " " + y1 + "," + (x2 - dx) + " " + y2 + "," + x2 + " " + y2;
    const p = el("path", { d, class: "tfe", pathLength: 1, "marker-end": "url(#tfarr)" });
    p.style.animationDelay = (b.layer * 0.12 + 0.2) + "s";
    const f = el("path", { d, class: "tff" });
    eg.appendChild(p); eg.appendChild(f);
    (edgeEls[e.to] = edgeEls[e.to] || []).push({ base: p, flow: f, from: e.from });
  });
  g.nodes.forEach(n => {
    const info = S.typeDef(n.type), c = S.CAT[info.cat] || S.CAT.other;
    const outer = el("g", { transform: "translate(" + n.x + " " + n.y + ")" });
    const gEl = el("g", { class: "tfn", "data-id": n.id }); outer.appendChild(gEl);
    gEl.style.animationDelay = (n.layer * 0.12) + "s";
    gEl.appendChild(el("rect", { class: "box", width: NW, height: NH, rx: 11 }));
    gEl.appendChild(el("rect", { x: 0, y: 0, width: 5, height: NH, rx: 2.5, fill: c }));
    gEl.appendChild(el("rect", { class: "spin", x: -2, y: -2, width: NW + 4, height: NH + 4 }));
    gEl.appendChild(el("text", { class: "ic", x: 17, y: 34 }, info.icon));
    const nm = n.name.length > 20 ? n.name.slice(0, 19) + "…" : n.name;
    gEl.appendChild(el("text", { class: "nm", x: 44, y: 24 }, nm));
    gEl.appendChild(el("text", { class: "ty", x: 44, y: 41 }, n.mode === "data" ? "data." + n.type : n.type.length > 24 ? n.type.slice(0, 23) + "…" : n.type));
    gEl.appendChild(el("circle", { class: "bdc", cx: NW - 15, cy: 15, r: 9 }));
    gEl.appendChild(el("text", { class: "bd", x: NW - 15, y: 15 }, ""));
    gEl.appendChild(el("title", {}, n.id));
    gEl.addEventListener("click", () => detail(n.id));
    ng.appendChild(outer);
    nodeEls[n.id] = gEl; nodeInfo[n.id] = n;
    setNode(n.id, ACT_ST[n.action] || "config");
  });
}
function setNode(id, st, kind) {
  const e = nodeEls[id]; if (!e) return;
  e.dataset.st = st; if (kind) e.dataset.k = kind; else delete e.dataset.k;
  e.querySelector(".bd").textContent = BADGE[st] || "";
  e.style.animation = "none"; void e.getBoundingClientRect(); e.style.animation = "";
}
function flow(id, on) {
  (edgeEls[id] || []).forEach(x => { x.flow.classList.toggle("on", on); if (!on && nodeEls[x.from] && /done|noop|exists/.test(nodeEls[x.from].dataset.st)) x.base.classList.add("lit"); });
}
function detail(id) {
  const n = nodeInfo[id], s = state.resources[id], box = els.tfDetail;
  let t = (n.mode === "data" ? "data." : "") + id.replace(/^data\./, "") + "\n";
  if (s) { t += "\n" + Object.keys(s.attrs).sort().filter(k => typeof s.attrs[k] !== "object").map(k => "  " + k + " = " + JSON.stringify(s.attrs[k])).join("\n"); }
  else t += "\n  (not in state yet)";
  box.textContent = t; box.style.display = "block";
}
function progress(done, total, t) {
  els.tfCount.textContent = done + " / " + total + " resources";
  els.tfBar.style.width = (total ? Math.round(done * 100 / total) : 0) + "%";
  els.tfClock.textContent = S.fmtDur(t || 0).replace(/^(\d+)s$/, "0m$1s") + " sim";
}
function drawDraft() {
  if (!active) return;
  const cfg = S.loadConfig(api.getCode()); cfgCache = cfg;
  if (!cfg.ok) { banner(cfg); return; }
  banner(null);
  if (!busy) draw(S.graphOf(cfg, state, null));
}
function onEdit() { if (!active) return; clearTimeout(draftTimer); draftTimer = setTimeout(drawDraft, 350); }

/* ───────────── commands ───────────── */
async function command(c) {
  if (c === "reset") { reset(true); return; }
  if (c === "pause") { paused = !paused; view.querySelector('[data-c="pause"]').textContent = paused ? "▶ resume" : "⏸ pause"; return; }
  if (busy) return;
  api.showTab("preview");
  const my = ++token; setBusy(true);
  try {
    if (c === "init") await doInit(my);
    else if (c === "validate") doValidate();
    else if (c === "plan") await doPlan(my, true);
    else if (c === "apply") await doApply(my, false);
    else if (c === "destroy") await doApply(my, true);
    else if (c === "state") doState();
    else if (c === "output") doOutput();
  } catch (e) { out("Error: " + (e && e.message || e), "err"); status("error", "err"); console.error(e); }
  if (my === token) setBusy(false);
}
async function runAll() {
  if (busy) { token++; busy = false; }
  api.showTab("preview");
  const my = ++token; setBusy(true);
  try {
    if (!(await doInit(my, true))) { if (my === token) setBusy(false); return; }
    if (my !== token) return;
    await doApply(my, false);
  } catch (e) { out("Error: " + (e && e.message || e), "err"); status("error", "err"); console.error(e); }
  if (my === token) setBusy(false);
}
async function wait(ms, my) {
  if (speed === 0 || ms <= 0) return my === token;
  const end = Date.now() + ms;
  while (Date.now() < end) { await sleep(Math.min(40, Math.max(5, end - Date.now()))); if (my !== token) return false; while (paused) { await sleep(60); if (my !== token) return false; } }
  return my === token;
}
async function doInit(my, quiet) {
  const cfg = getCfg(true); if (!cfg) return false;
  cmdEcho("init"); status("initializing…", "busy");
  out("");
  for (const s of S.initSteps(cfg)) { out(s.text, s.cls === "ok" ? "ok" : undefined); if (speed && s.provider && s.kind !== "find") { if (!(await wait(160 + Math.random() * 140, my))) return false; } }
  initialized = true; status("initialized", "ok");
  drawDraft();
  return true;
}
function doValidate() {
  cmdEcho("validate");
  const cfg = getCfg(true); if (!cfg) return;
  out(["Success! The configuration is valid.", ""], "ok"); status("valid", "ok");
}
function needInit() {
  if (initialized) return false;
  out(["╷", "│ Error: Inconsistent dependency lock file", "│", "│ Providers required by the configuration are missing from the lock file.", "│", "│ To make the initial dependency selections that will initialize the dependency", '│ lock file, run: terraform init', "╵"], "err");
  status("run init first", "err"); return true;
}
async function doPlan(my, announce, cfgOverride, destroyMode) {
  const cfg = cfgOverride || getCfg(true); if (!cfg) return null;
  if (announce) cmdEcho("plan");
  if (needInit()) return null;
  status("planning…", "busy");
  const P = S.plan(cfg, state, { rng: S.mulberry32(Date.now() & 0xffff) });
  const existing = S.stateList(state);
  if (existing.length) { out(""); existing.forEach(a => out(a + ": Refreshing state... [id=" + (state.resources[a].attrs.id) + "]")); }
  if (P.errors.length) { P.errors.forEach(e => out(S.formatDiagnostic(e, cfg), "err")); status("plan failed", "err"); draw(S.graphOf(cfg, state, null)); return null; }
  P.dataReads.forEach(r => { out(r.addr.startsWith("data.") ? r.addr + ": Reading..." : "data." + r.addr + ": Reading..."); out((r.addr.startsWith("data.") ? r.addr : "data." + r.addr) + ": Read complete after 0s [id=" + r.id + "]"); });
  if (P.mockVars.length) out(P.mockVars.map(v => "(simulator) no value for var." + v.name + " — using mock value " + JSON.stringify(v.value)), "sys");
  draw(S.graphOf(cfg, state, P));
  if (!P.hasChanges) {
    out(["", "No changes. Your infrastructure matches the configuration.", "", "Terraform has compared your real infrastructure against your configuration", "and found no differences, so no changes are needed."], "ok");
    status("up to date", "ok"); return P;
  }
  out("");
  out(S.planHeader(P));
  P.changes.filter(c => c.action !== "noop").forEach(c => { out(S.renderChange(c)); out(""); });
  out(S.planSummary(P), "info");
  out(S.outputChangeLines(P));
  if (announce) out(["", "─────────────────────────────────────────────────────────────────────────────", "", "Note: You didn't use the -out option to save this plan, so Terraform can't", 'guarantee to take exactly these actions if you run "terraform apply" now.']);
  status("plan ready", "ok");
  return P;
}
async function doApply(my, destroyAll) {
  cmdEcho(destroyAll ? "destroy -auto-approve" : "apply -auto-approve");
  let cfg;
  if (destroyAll) { cfg = S.loadConfig(""); if (!Object.keys(state.resources).length) { out(["", "No changes. No objects need to be destroyed.", "", "Either you have not created any objects yet or the existing objects were", "already deleted outside of Terraform."], "ok"); status("nothing to destroy", "ok"); return; } }
  else { cfg = getCfg(true); if (!cfg) return; }
  if (needInit()) return;
  const P = await doPlan(my, false, cfg, destroyAll);
  if (!P || my !== token) return;
  if (!P.hasChanges) return;
  if (!P.changes.some(c => c.action !== "noop")) { /* output-only change */ }
  out("");
  const total = P.changes.filter(c => c.action !== "noop").reduce((n, c) => n + (c.action === "replace" ? 2 : 1), 0);
  let done = 0, errors = [], counts = { add: 0, change: 0, destroy: 0 };
  progress(0, total, 0); status("applying…", "busy");
  els.tfLog.scrollTop = els.tfLog.scrollHeight;
  P.changes.forEach(c => { if (c.action === "noop") setNode(c.addr, "noop"); });
  let prevT = 0;
  const gen = S.applyGen(cfg, state, P, { rng: S.mulberry32((Date.now() >> 3) & 0xffff), parallelism: 10 });
  const fail = new Set();
  for (const e of gen) {
    if (my !== token) { saveState(); return; }
    if (e.type !== "finish" && !(await wait((e.t - prevT) * 1000 / (speed || 1), my))) { saveState(); return; }
    if (e.type !== "finish") prevT = e.t;
    const a = e.addr, id = e.id || (e.op && e.op.change.before && e.op.change.before.id);
    if (e.type === "start") {
      if (e.kind === "create") { out(a + ": Creating..."); setNode(a, "work", "create"); }
      else if (e.kind === "update") { out(a + ": Modifying... [id=" + id + "]"); setNode(a, "work", "update"); }
      else { out(a + ": Destroying... [id=" + id + "]"); setNode(a, "work", "delete"); }
      flow(a, true);
    } else if (e.type === "still") {
      const verb = e.kind === "create" ? "creating... " : e.kind === "update" ? "modifying... [id=" + e.id + ", " : "destroying... [id=" + e.id + ", ";
      out(a + ": Still " + (e.kind === "create" ? "creating... [" + S.fmtDur(e.elapsed) + " elapsed]" : (e.kind === "update" ? "modifying... [id=" : "destroying... [id=") + e.id + ", " + S.fmtDur(e.elapsed) + " elapsed]"));
    } else if (e.type === "done") {
      done++; flow(a, false);
      if (e.kind === "create") { out(a + ": Creation complete after " + S.fmtDur(e.elapsed) + " [id=" + e.id + "]"); setNode(a, "done"); counts.add++; }
      else if (e.kind === "update") { out(a + ": Modifications complete after " + S.fmtDur(e.elapsed) + " [id=" + e.id + "]"); setNode(a, "done"); counts.change++; }
      else { out(a + ": Destruction complete after " + S.fmtDur(e.elapsed)); counts.destroy++; setNode(a, e.op.replace ? "p-create" : "gone"); }
      progress(done, total, e.t);
    } else if (e.type === "error") {
      flow(a, false); setNode(a, "fail"); errors.push(e.error); fail.add(a); status("apply failed", "err");
      out(a + ": " + (e.kind === "create" ? "Creation" : e.kind === "update" ? "Modification" : "Destruction") + " errored after " + S.fmtDur(e.elapsed), "err");
    } else if (e.type === "finish") {
      progress(done, total, e.t);
      for (const addr of Object.keys(nodeEls)) { const st = nodeEls[addr].dataset.st; if (/^p-/.test(st) && !fail.has(addr)) setNode(addr, "skip"); }
      saveState();
      if (errors.length) {
        errors.forEach(er => out(S.formatDiagnostic(er, cfg), "err"));
      } else {
        out("");
        if (destroyAll) out("Destroy complete! Resources: " + counts.destroy + " destroyed.", "ok");
        else out("Apply complete! Resources: " + counts.add + " added, " + counts.change + " changed, " + counts.destroy + " destroyed.", "ok");
        const names = Object.keys(e.outputs || {});
        if (names.length) { out(["", "Outputs:", ""]); out(S.outputsText(e.outputs, cfg)); }
        status(destroyAll ? "destroyed" : "apply complete", "ok");
      }
    }
  }
}
function doState() {
  cmdEcho("state list"); const l = S.stateList(state);
  if (!l.length) { out("No state file was found!  (nothing has been applied yet)", "warn"); return; }
  out(l); status(l.length + " in state", "ok");
}
function doOutput() {
  cmdEcho("output"); const cfg = cfgCache && cfgCache.ok ? cfgCache : S.loadConfig(api.getCode());
  out(S.outputsText(state.outputs || {}, cfg));
}
function reset(announce) {
  token++; setBusy(false);
  state = S.newState(); saveState(); initialized = false;
  els.tfLog.innerHTML = ""; progress(0, 0, 0);
  if (announce) out("State cleared — terraform.tfstate removed. Run init again.", "warn");
  status("idle", "idle"); drawDraft();
}

/* ───────────── public API ───────────── */
window.TFUI = {
  mount, runAll,
  activate() { active = true; view.classList.add("on"); drawDraft(); },
  deactivate() { active = false; view.classList.remove("on"); token++; setBusy(false); },
  onEdit,
  stop() { token++; if (busy) { setBusy(false); out("■ stopped by user (state saved so far is kept)", "warn"); status("stopped", "idle"); saveState(); } },
  resetState() { reset(false); }
};
})();
