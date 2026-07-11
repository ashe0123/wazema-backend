#!/bin/bash

###############################################################################
# Wazema SCBC Deployment Script
# Automated deployment with health checks and rollback
###############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
APP_NAME="wazema-api"
BACKUP_DIR="./backups"
HEALTH_ENDPOINT="http://localhost:3002/api/health/ready"
MAX_HEALTH_RETRIES=30
HEALTH_RETRY_DELAY=2

echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}   Wazema SCBC - Production Deployment Script${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""

# Step 1: Pre-deployment checks
echo -e "${YELLOW}[1/7]${NC} Running pre-deployment checks..."

# Check if .env exists
if [ ! -f ".env" ]; then
    echo -e "${RED}ERROR: .env file not found!${NC}"
    echo "Please create .env from .env.production.example"
    exit 1
fi

# Check required environment variables
required_vars=("DATABASE_URL" "JWT_SECRET" "ADMIN_PASSWORD")
for var in "${required_vars[@]}"; do
    if ! grep -q "^${var}=" .env || grep -q "^${var}=CHANGE" .env; then
        echo -e "${RED}ERROR: ${var} not configured in .env${NC}"
        exit 1
    fi
done

echo -e "${GREEN}✓${NC} Pre-deployment checks passed"
echo ""

# Step 2: Install dependencies
echo -e "${YELLOW}[2/7]${NC} Installing dependencies..."
npm ci --production
echo -e "${GREEN}✓${NC} Dependencies installed"
echo ""

# Step 3: Backup current state (if PM2 is running)
if pm2 describe $APP_NAME > /dev/null 2>&1; then
    echo -e "${YELLOW}[3/7]${NC} Creating backup..."
    mkdir -p $BACKUP_DIR
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    pm2 save --force
    cp ~/.pm2/dump.pm2 "$BACKUP_DIR/dump.pm2.$TIMESTAMP"
    echo -e "${GREEN}✓${NC} Backup created: $BACKUP_DIR/dump.pm2.$TIMESTAMP"
else
    echo -e "${YELLOW}[3/7]${NC} No existing deployment found, skipping backup"
fi
echo ""

# Step 4: Database migrations (if any)
echo -e "${YELLOW}[4/7]${NC} Checking database..."
node -e "const db = require('./db'); db.one('SELECT 1 as test').then(() => { console.log('Database connected'); process.exit(0); }).catch(e => { console.error('Database error:', e.message); process.exit(1); })" 2>&1 | grep -q "Database connected"
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓${NC} Database connection verified"
else
    echo -e "${RED}ERROR: Cannot connect to database${NC}"
    exit 1
fi
echo ""

# Step 5: Start/Reload PM2
echo -e "${YELLOW}[5/7]${NC} Deploying application..."

if pm2 describe $APP_NAME > /dev/null 2>&1; then
    echo "Reloading existing instances (zero-downtime)..."
    pm2 reload ecosystem.config.js --update-env
else
    echo "Starting new instances..."
    pm2 start ecosystem.config.js
fi

echo -e "${GREEN}✓${NC} Application deployed"
echo ""

# Step 6: Health check
echo -e "${YELLOW}[6/7]${NC} Running health checks..."

health_check() {
    for i in $(seq 1 $MAX_HEALTH_RETRIES); do
        echo -n "  Attempt $i/$MAX_HEALTH_RETRIES... "
        
        if curl -sf $HEALTH_ENDPOINT > /dev/null 2>&1; then
            echo -e "${GREEN}OK${NC}"
            return 0
        else
            echo -e "${RED}FAILED${NC}"
            if [ $i -lt $MAX_HEALTH_RETRIES ]; then
                sleep $HEALTH_RETRY_DELAY
            fi
        fi
    done
    return 1
}

if health_check; then
    echo -e "${GREEN}✓${NC} Health checks passed"
else
    echo -e "${RED}ERROR: Health checks failed after $MAX_HEALTH_RETRIES attempts${NC}"
    echo ""
    echo -e "${YELLOW}Rolling back to previous version...${NC}"
    
    # Rollback
    if [ -f "$BACKUP_DIR/dump.pm2.$TIMESTAMP" ]; then
        pm2 resurrect $BACKUP_DIR/dump.pm2.$TIMESTAMP
        echo -e "${GREEN}✓${NC} Rolled back to previous version"
    else
        echo -e "${RED}ERROR: No backup found for rollback${NC}"
        pm2 stop $APP_NAME
    fi
    exit 1
fi
echo ""

# Step 7: Post-deployment tasks
echo -e "${YELLOW}[7/7]${NC} Running post-deployment tasks..."

# Save PM2 state
pm2 save --force

# Show status
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}   Deployment Successful!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""

pm2 status
echo ""

# Show health status
echo "Health Check:"
curl -s $HEALTH_ENDPOINT | jq '.' 2>/dev/null || curl -s $HEALTH_ENDPOINT
echo ""
echo ""

# Show logs command
echo -e "${YELLOW}Useful commands:${NC}"
echo "  View logs:      pm2 logs $APP_NAME"
echo "  Monitor:        pm2 monit"
echo "  Stop:           pm2 stop $APP_NAME"
echo "  Restart:        pm2 restart $APP_NAME"
echo "  Status:         pm2 status"
echo ""

exit 0
